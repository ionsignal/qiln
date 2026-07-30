import {
  createCapsuleBlueprintReference,
  createCapsuleRouteApplicationPin,
  digestCapsuleRouteConfiguration,
  type CapsuleBranchPreviewListOutput,
} from '@qiln/core/server'
import {
  CaddyError,
  CaddyMutationOutcome,
  type CaddyClient,
  type CaddyManagedRouteEntry,
  type CaddyRoutesState,
} from '../../../../caddy'
import { IncusError } from '../../../../errors'
import type { CapsuleBranchProvenance } from '../../branch/provenance'
import type { CapsulePreviewEventPublisher } from '../../events'
import type { PreviewHost } from './host'
import type { PreviewPlanner } from './plan'
import type { PreviewProbe } from './probe'
import type { PreviewStore } from './store'
import type { PreviewBranch, PreviewPlan, PreviewRecord } from './types'

interface ApplyRecovery {
  preview: PreviewRecord
  continueReconciliation: boolean
}

export interface PreviewServiceDependencies {
  store: PreviewStore
  provenance: CapsuleBranchProvenance
  host: PreviewHost
  planner: PreviewPlanner
  probe: PreviewProbe
  caddy: CaddyClient
  reconcileBranches: () => Promise<void>
  events: CapsulePreviewEventPublisher
  intervalMs: number
}

/**
 * Reconciles mutable branch previews from PostgreSQL-authoritative state.
 *
 * A preview never adopts an unaccounted Caddy route. Current and pending
 * configuration identities distinguish a known prior route from a mutation
 * intent that may have been interrupted after the database committed.
 */
export class PreviewService {
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<void> | null = null
  private stopped = false

  constructor(private readonly dependencies: PreviewServiceDependencies) {}

  public async list(ownerId: string, capsuleId: string): Promise<CapsuleBranchPreviewListOutput> {
    return await this.dependencies.store.list(ownerId, capsuleId)
  }

  /**
   * Requests durable preview withdrawal before a branch runtime mutation.
   *
   * The request is persisted before Caddy removal begins so periodic
   * reconciliation cannot recreate ingress while branch stop waits for the
   * withdrawal gate to become satisfied.
   */
  public async withdrawBranch(ownerId: string, capsuleId: string, branchId: string): Promise<void> {
    await this.runExclusive(async () => {
      const previews = await this.dependencies.store.requestWithdrawal(ownerId, capsuleId, branchId)

      for (const preview of previews) {
        await this.withdraw(preview)
      }
    })
  }

  /**
   * Restores preview eligibility after an explicit branch-start request.
   *
   * The branch remains `starting` until Incus confirms it is online, so
   * clearing the withdrawal request cannot itself recreate Caddy ingress.
   */
  public async resumeBranch(ownerId: string, capsuleId: string, branchId: string): Promise<void> {
    await this.runExclusive(async () => {
      await this.dependencies.store.resume(ownerId, capsuleId, branchId)
    })
  }

  public start(): void {
    if (this.timer || this.stopped) {
      return
    }
    this.timer = setInterval(() => {
      void this.tick()
    }, this.dependencies.intervalMs)
    this.timer.unref()
  }

  public async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.running) {
      await this.running
    }
  }

  public async reconcile(): Promise<void> {
    if (this.running) {
      await this.running
      return
    }
    await this.runExclusive(async () => {
      await this.reconcileAll()
    })
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) {
      return
    }
    try {
      await this.runExclusive(async () => {
        await this.dependencies.reconcileBranches()
        await this.reconcileAll()
      })
    } catch (error: unknown) {
      console.warn('[PreviewService] Periodic preview reconciliation failed.', error)
    }
  }

  private async reconcileAll(): Promise<void> {
    const [branches, existing] = await Promise.all([this.dependencies.store.branches(), this.dependencies.store.all()])
    const previewsByBranch = new Map<string, PreviewRecord[]>()
    for (const preview of existing) {
      const previews = previewsByBranch.get(preview.branchId) ?? []
      previews.push(preview)
      previewsByBranch.set(preview.branchId, previews)
    }
    for (const branch of branches) {
      await this.reconcileBranch(branch, previewsByBranch.get(branch.id) ?? [])
    }
  }

  private async reconcileBranch(branch: PreviewBranch, existing: readonly PreviewRecord[]): Promise<void> {
    const withdrawalRequested = existing.some(preview => preview.withdrawalRequestedAt !== null)
    if (!this.isEligible(branch) || withdrawalRequested) {
      const previews = withdrawalRequested
        ? await this.dependencies.store.requestWithdrawal(branch.ownerId, branch.capsuleId, branch.id)
        : existing
      for (const preview of previews) {
        await this.withdraw(preview)
      }
      return
    }
    try {
      const pins = await this.dependencies.provenance.load(await this.dependencies.store.branch(branch.id))
      const desiredNames = new Set<string>()
      for (const application of pins.blueprint.blueprint.applications) {
        if (application.exposure !== 'proxy') {
          continue
        }
        desiredNames.add(application.name)
        let preview: PreviewRecord | undefined
        try {
          const applicationPin = createCapsuleRouteApplicationPin({
            schemaVersion: 1,
            blueprint: createCapsuleBlueprintReference(pins.blueprint),
            application,
          })
          const identity = this.dependencies.host.create(branch.id, application.name)
          preview = await this.dependencies.store.ensure(branch, applicationPin, identity)
          await this.apply(preview, branch.runtimeIp!)
        } catch (error: unknown) {
          const existingPreview = preview ?? existing.find(candidate => candidate.applicationName === application.name)
          if (existingPreview) {
            await this.cleanup(existingPreview, error, {
              phase: 'plan_preview',
            })
            continue
          }
          console.warn(
            `[PreviewService] Could not create preview for branch '${branch.id}' application '${application.name}'.`,
            error,
          )
        }
      }
      for (const preview of existing) {
        if (!desiredNames.has(preview.applicationName)) {
          await this.withdraw(preview)
        }
      }
    } catch (error: unknown) {
      for (const preview of existing) {
        await this.cleanup(preview, error, {
          phase: 'load_branch_provenance',
        })
      }
    }
  }

  private async apply(preview: PreviewRecord, runtimeIp: string): Promise<void> {
    if (preview.status === 'cleanup_required' || preview.withdrawalRequestedAt !== null) {
      return
    }
    const plan = this.dependencies.planner.create(preview, runtimeIp)
    const state = await this.readCaddy(preview, 'inspect_caddy_route')
    if (!state) {
      return
    }
    const observed = this.find(state, preview.providerRouteId)
    const recovery = await this.recoverApplying(preview, observed)
    if (!recovery) {
      return
    }
    preview = recovery.preview
    if (
      !recovery.continueReconciliation ||
      preview.status === 'cleanup_required' ||
      preview.withdrawalRequestedAt !== null
    ) {
      return
    }
    if (!observed) {
      if (preview.status !== 'inactive') {
        preview = await this.publish(await this.dependencies.store.inactive(preview.id))
      }
      await this.create(preview, plan, state)
      return
    }
    if (preview.status === 'inactive') {
      await this.cleanup(
        preview,
        new IncusError('Inactive branch preview retains an unaccounted Caddy route.', 'CONFLICT'),
        {
          phase: 'inspect_inactive_preview',
        },
      )
      return
    }
    if (!this.matchesPersisted(observed, preview)) {
      await this.cleanup(
        preview,
        new IncusError('Observed Caddy preview route does not match durable current configuration.', 'CONFLICT'),
        {
          phase: 'inspect_caddy_route',
        },
      )
      return
    }
    if (this.matches(observed, plan)) {
      await this.verify(preview, plan)
      return
    }
    await this.replace(preview, plan, state)
  }

  private async create(preview: PreviewRecord, plan: PreviewPlan, state: CaddyRoutesState): Promise<void> {
    try {
      await this.dependencies.probe.upstream(plan)
    } catch (error: unknown) {
      console.warn(
        `[PreviewService] Preview '${preview.id}' has no confirmed upstream for its initial Caddy route.`,
        error,
      )
      return
    }
    const applying = await this.publish(await this.dependencies.store.apply(preview.id, plan))
    try {
      const observedState = await this.dependencies.caddy.routes.create(plan.route, state)
      const observed = this.find(observedState, applying.providerRouteId)
      if (!observed || !this.matches(observed, plan)) {
        await this.cleanup(
          applying,
          new IncusError('Caddy create returned without the expected preview route configuration.', 'CONFLICT'),
          {
            phase: 'verify_caddy_create_readback',
          },
        )
        return
      }
      const verifying = await this.publish(await this.dependencies.store.applied(applying.id))
      await this.verify(verifying, plan)
    } catch (error: unknown) {
      await this.handleApplyFailure(applying, error)
    }
  }

  private async replace(preview: PreviewRecord, plan: PreviewPlan, state: CaddyRoutesState): Promise<void> {
    try {
      await this.dependencies.probe.upstream(plan)
    } catch (error: unknown) {
      await this.publish(
        await this.dependencies.store.degraded(preview.id, error, {
          phase: 'verify_desired_upstream_before_replace',
          plannedRuntimeIp: plan.runtimeIp,
        }),
      )
      return
    }
    const applying = await this.publish(await this.dependencies.store.apply(preview.id, plan))
    try {
      const observedState = await this.dependencies.caddy.routes.replace(plan.route, state)
      const observed = this.find(observedState, applying.providerRouteId)
      if (!observed || !this.matches(observed, plan)) {
        await this.cleanup(
          applying,
          new IncusError('Caddy replacement returned without the expected preview route configuration.', 'CONFLICT'),
          {
            phase: 'verify_caddy_replace_readback',
          },
        )
        return
      }
      const verifying = await this.publish(await this.dependencies.store.applied(applying.id))
      await this.verify(verifying, plan)
    } catch (error: unknown) {
      await this.handleApplyFailure(applying, error)
    }
  }

  private async verify(preview: PreviewRecord, plan: PreviewPlan): Promise<void> {
    try {
      const evidence = await this.dependencies.probe.route(plan)
      if (preview.status === 'verifying' || preview.status === 'degraded') {
        await this.publish(await this.dependencies.store.active(preview.id, evidence))
      }
    } catch (error: unknown) {
      if (preview.status === 'active' || preview.status === 'verifying' || preview.status === 'degraded') {
        await this.publish(
          await this.dependencies.store.degraded(preview.id, error, {
            phase: preview.status === 'active' ? 'periodic_route_verification' : 'route_verification',
          }),
        )
      }
    }
  }

  private async withdraw(preview: PreviewRecord): Promise<void> {
    if (preview.status === 'cleanup_required') {
      return
    }
    const state = await this.readCaddy(preview, 'inspect_preview_withdrawal')
    if (!state) {
      return
    }
    const observed = this.find(state, preview.providerRouteId)
    const recovery = await this.recoverApplying(preview, observed)
    if (!recovery) {
      return
    }
    preview = recovery.preview
    if (preview.status === 'cleanup_required') {
      return
    }
    if (preview.status === 'removing') {
      await this.recoverRemoving(preview, observed)
      return
    }
    if (!observed) {
      if (preview.status !== 'inactive') {
        await this.publish(await this.dependencies.store.inactive(preview.id))
      }
      return
    }
    if (preview.status === 'inactive') {
      await this.cleanup(
        preview,
        new IncusError('Inactive branch preview retains an unaccounted Caddy route.', 'CONFLICT'),
        {
          phase: 'withdraw_inactive_preview',
        },
      )
      return
    }
    if (!this.matchesPersisted(observed, preview)) {
      await this.cleanup(
        preview,
        new IncusError('Caddy preview route cannot be matched to durable withdrawal authority.', 'CONFLICT'),
        {
          phase: 'prepare_preview_withdrawal',
        },
      )
      return
    }
    const removing = await this.publish(await this.dependencies.store.removing(preview.id))
    try {
      const observedState = await this.dependencies.caddy.routes.delete(removing.providerRouteId, state)
      const remaining = this.find(observedState, removing.providerRouteId)
      if (remaining) {
        await this.cleanup(
          removing,
          new IncusError('Caddy deletion returned while the preview route remained present.', 'CONFLICT'),
          {
            phase: 'verify_caddy_removal_readback',
          },
        )
        return
      }
      await this.publish(await this.dependencies.store.inactive(removing.id))
    } catch (error: unknown) {
      await this.handleRemovalFailure(removing, error)
    }
  }

  private async recoverApplying(
    preview: PreviewRecord,
    observed: CaddyManagedRouteEntry | undefined,
  ): Promise<ApplyRecovery | null> {
    if (preview.status !== 'applying') {
      return {
        preview,
        continueReconciliation: true,
      }
    }
    if (observed && this.matchesPending(observed, preview)) {
      return {
        preview: await this.publish(await this.dependencies.store.applied(preview.id)),
        continueReconciliation: true,
      }
    }
    if (observed && this.matchesPersisted(observed, preview)) {
      return {
        preview: await this.publish(
          await this.dependencies.store.rejectApply(
            preview.id,
            new IncusError(
              'Caddy preview replacement did not take effect and retained its known current route.',
              'CONFLICT',
            ),
            {
              phase: 'recover_applying_current_configuration',
            },
          ),
        ),
        continueReconciliation: false,
      }
    }
    await this.cleanup(
      preview,
      new IncusError(
        'Applying branch preview cannot prove whether Caddy contains its current or pending route.',
        'CONFLICT',
      ),
      {
        phase: 'recover_applying_unknown_configuration',
      },
    )
    return null
  }

  private async recoverRemoving(preview: PreviewRecord, observed: CaddyManagedRouteEntry | undefined): Promise<void> {
    if (!observed) {
      await this.publish(await this.dependencies.store.inactive(preview.id))
      return
    }
    if (this.matchesPersisted(observed, preview)) {
      await this.publish(
        await this.dependencies.store.rejectRemoval(
          preview.id,
          new IncusError('Caddy preview removal did not take effect and retained its known current route.', 'CONFLICT'),
          {
            phase: 'recover_removing_current_configuration',
          },
        ),
      )
      return
    }
    await this.cleanup(
      preview,
      new IncusError('Removing branch preview no longer matches its durable current Caddy configuration.', 'CONFLICT'),
      {
        phase: 'recover_removing_mismatched_configuration',
      },
    )
  }

  private async handleApplyFailure(preview: PreviewRecord, error: unknown): Promise<void> {
    if (!this.isConfirmedRejection(error)) {
      await this.cleanup(preview, error, {
        phase: 'apply_caddy_route',
      })
      return
    }
    const state = await this.readCaddy(preview, 'recover_rejected_caddy_apply')
    if (!state) {
      return
    }
    const observed = this.find(state, preview.providerRouteId)
    if (observed && this.matchesPending(observed, preview)) {
      await this.publish(await this.dependencies.store.applied(preview.id))
      return
    }
    if (observed && this.matchesPersisted(observed, preview)) {
      await this.publish(
        await this.dependencies.store.rejectApply(preview.id, error, {
          phase: 'apply_caddy_route_rejected',
        }),
      )
      return
    }
    if (!observed && preview.currentConfigurationDigest === null) {
      await this.publish(
        await this.dependencies.store.rejectApply(preview.id, error, {
          phase: 'create_caddy_route_rejected',
        }),
      )
      return
    }
    await this.cleanup(
      preview,
      new IncusError(
        'Rejected Caddy preview application left a route state that does not match durable authority.',
        'CONFLICT',
      ),
      {
        phase: 'recover_rejected_caddy_apply',
      },
    )
  }

  private async handleRemovalFailure(preview: PreviewRecord, error: unknown): Promise<void> {
    if (!this.isConfirmedRejection(error)) {
      await this.cleanup(preview, error, {
        phase: 'remove_caddy_route',
      })
      return
    }
    const state = await this.readCaddy(preview, 'recover_rejected_caddy_removal')
    if (!state) {
      return
    }
    await this.recoverRemoving(preview, this.find(state, preview.providerRouteId))
  }

  private async readCaddy(preview: PreviewRecord, phase: string): Promise<CaddyRoutesState | null> {
    try {
      return await this.dependencies.caddy.routes.read()
    } catch (error: unknown) {
      await this.cleanup(preview, error, {
        phase,
      })
      return null
    }
  }

  private isConfirmedRejection(error: unknown): boolean {
    return error instanceof CaddyError && error.outcome !== CaddyMutationOutcome.UNKNOWN
  }

  private async cleanup(preview: PreviewRecord, error: unknown, context: Record<string, unknown>): Promise<void> {
    if (preview.status === 'cleanup_required') {
      return
    }

    await this.publish(
      await this.dependencies.store.cleanup(preview.id, error, {
        previewId: preview.id,
        capsuleId: preview.capsuleId,
        branchId: preview.branchId,
        applicationName: preview.applicationName,
        ...context,
      }),
    )
  }

  private find(state: CaddyRoutesState, routeId: string): CaddyManagedRouteEntry | undefined {
    return state.routes.find(route => route.id === routeId)
  }

  private matches(route: CaddyManagedRouteEntry, plan: PreviewPlan): boolean {
    return this.digest(route.route) === plan.configurationDigest
  }

  private matchesPersisted(route: CaddyManagedRouteEntry, preview: PreviewRecord): boolean {
    return (
      preview.currentConfigurationDigest !== null && this.digest(route.route) === preview.currentConfigurationDigest
    )
  }

  private matchesPending(route: CaddyManagedRouteEntry, preview: PreviewRecord): boolean {
    return (
      preview.pendingConfigurationDigest !== null && this.digest(route.route) === preview.pendingConfigurationDigest
    )
  }

  private digest(value: Record<string, unknown>): string {
    return digestCapsuleRouteConfiguration(value)
  }

  private isEligible(branch: PreviewBranch): boolean {
    return (
      branch.lifecycleStatus === 'active' &&
      branch.archivedAt === null &&
      branch.status === 'online' &&
      branch.runtimeIp !== null &&
      !branch.operationBlocked
    )
  }

  private async publish(preview: PreviewRecord): Promise<PreviewRecord> {
    this.dependencies.events.changed(preview)
    return preview
  }

  private async runExclusive<TResult>(action: () => Promise<TResult>): Promise<TResult> {
    while (this.running) {
      await this.running
    }
    const execution = Promise.resolve().then(action)
    const completion = execution.then(
      () => undefined,
      () => undefined,
    )
    this.running = completion
    try {
      return await execution
    } finally {
      if (this.running === completion) {
        this.running = null
      }
    }
  }
}
