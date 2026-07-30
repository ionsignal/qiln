import {
  createCapsuleBlueprintReference,
  createCapsuleRouteApplicationPin,
  digestCapsuleRouteConfiguration,
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
import type { PreviewRepository } from './persistence'
import { recoverApply, recoverRemoval } from './recovery'
import type { PreviewBranch, PreviewPlan, PreviewRecord } from './types'

interface ApplyRecoveryResult {
  preview: PreviewRecord
  continueReconciliation: boolean
}

export interface PreviewRouteControllerDependencies {
  repository: PreviewRepository
  provenance: CapsuleBranchProvenance
  host: PreviewHost
  planner: PreviewPlanner
  probe: PreviewProbe
  caddy: CaddyClient
  events: CapsulePreviewEventPublisher
}

/**
 * Reconciles one editable branch and its application previews against Caddy.
 *
 * PostgreSQL persistence owns durable transition eligibility and locking. This
 * controller owns historical provenance resolution, desired route planning,
 * Caddy mutation/readback, recovery decisions, route probing, and post-commit
 * invalidations.
 *
 * It never performs Caddy calls inside a PostgreSQL transaction and never
 * retries an ambiguous provider mutation.
 */
export class PreviewRouteController {
  constructor(private readonly dependencies: PreviewRouteControllerDependencies) {}

  public async reconcile(branch: PreviewBranch, existing: readonly PreviewRecord[]): Promise<void> {
    const withdrawalRequested = existing.some(preview => preview.withdrawalRequestedAt !== null)
    if (!this.eligible(branch) || withdrawalRequested) {
      const previews = withdrawalRequested
        ? await this.dependencies.repository.withdraw(branch.ownerId, branch.capsuleId, branch.id)
        : existing
      for (const preview of previews) {
        await this.withdraw(preview)
      }
      return
    }
    try {
      const persistedBranch = await this.dependencies.repository.branch(branch.id)
      const pins = await this.dependencies.provenance.load(persistedBranch)
      const desiredApplications = new Set<string>()
      for (const application of pins.blueprint.blueprint.applications) {
        if (application.exposure !== 'proxy') {
          continue
        }
        desiredApplications.add(application.name)
        let preview: PreviewRecord | undefined
        try {
          const applicationPin = createCapsuleRouteApplicationPin({
            schemaVersion: 1,
            blueprint: createCapsuleBlueprintReference(pins.blueprint),
            application,
          })
          const identity = this.dependencies.host.create(branch.id, application.name)
          preview = await this.dependencies.repository.ensure(branch, applicationPin, identity)
          await this.apply(preview, branch.runtimeIp!)
        } catch (error: unknown) {
          const persistedPreview = preview ?? existing.find(candidate => candidate.applicationName === application.name)
          if (persistedPreview) {
            await this.cleanup(persistedPreview, error, {
              phase: 'plan_preview',
            })
            continue
          }
          console.warn(
            `[PreviewRouteController] Could not create preview for branch '${branch.id}' application '${application.name}'.`,
            error,
          )
        }
      }
      for (const preview of existing) {
        if (!desiredApplications.has(preview.applicationName)) {
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

  public async withdraw(preview: PreviewRecord): Promise<void> {
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
        this.changed(await this.dependencies.repository.inactive(preview.id))
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
    if (!this.matchesCurrent(observed, preview)) {
      await this.cleanup(
        preview,
        new IncusError('Caddy preview route cannot be matched to durable withdrawal authority.', 'CONFLICT'),
        {
          phase: 'prepare_preview_withdrawal',
        },
      )
      return
    }
    const removing = this.changed(await this.dependencies.repository.removing(preview.id))
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
      this.changed(await this.dependencies.repository.inactive(removing.id))
    } catch (error: unknown) {
      await this.handleRemovalFailure(removing, error)
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
        preview = this.changed(await this.dependencies.repository.inactive(preview.id))
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
    if (!this.matchesCurrent(observed, preview)) {
      await this.cleanup(
        preview,
        new IncusError('Observed Caddy preview route does not match durable current configuration.', 'CONFLICT'),
        {
          phase: 'inspect_caddy_route',
        },
      )
      return
    }
    if (this.matchesPlan(observed, plan)) {
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
        `[PreviewRouteController] Preview '${preview.id}' has no confirmed upstream for its initial Caddy route.`,
        error,
      )
      return
    }
    const applying = this.changed(await this.dependencies.repository.apply(preview.id, plan))
    try {
      const observedState = await this.dependencies.caddy.routes.create(plan.route, state)
      const observed = this.find(observedState, applying.providerRouteId)
      if (!observed || !this.matchesPlan(observed, plan)) {
        await this.cleanup(
          applying,
          new IncusError('Caddy create returned without the expected preview route configuration.', 'CONFLICT'),
          {
            phase: 'verify_caddy_create_readback',
          },
        )
        return
      }
      const verifying = this.changed(await this.dependencies.repository.applied(applying.id))
      await this.verify(verifying, plan)
    } catch (error: unknown) {
      await this.handleApplyFailure(applying, error)
    }
  }

  private async replace(preview: PreviewRecord, plan: PreviewPlan, state: CaddyRoutesState): Promise<void> {
    try {
      await this.dependencies.probe.upstream(plan)
    } catch (error: unknown) {
      this.changed(
        await this.dependencies.repository.degraded(preview.id, error, {
          phase: 'verify_desired_upstream_before_replace',
          plannedRuntimeIp: plan.runtimeIp,
        }),
      )
      return
    }
    const applying = this.changed(await this.dependencies.repository.apply(preview.id, plan))
    try {
      const observedState = await this.dependencies.caddy.routes.replace(plan.route, state)
      const observed = this.find(observedState, applying.providerRouteId)
      if (!observed || !this.matchesPlan(observed, plan)) {
        await this.cleanup(
          applying,
          new IncusError('Caddy replacement returned without the expected preview route configuration.', 'CONFLICT'),
          {
            phase: 'verify_caddy_replace_readback',
          },
        )
        return
      }
      const verifying = this.changed(await this.dependencies.repository.applied(applying.id))
      await this.verify(verifying, plan)
    } catch (error: unknown) {
      await this.handleApplyFailure(applying, error)
    }
  }

  private async verify(preview: PreviewRecord, plan: PreviewPlan): Promise<void> {
    try {
      const evidence = await this.dependencies.probe.route(plan)
      if (preview.status === 'verifying' || preview.status === 'degraded') {
        this.changed(await this.dependencies.repository.active(preview.id, evidence))
      }
    } catch (error: unknown) {
      if (preview.status === 'active' || preview.status === 'verifying' || preview.status === 'degraded') {
        this.changed(
          await this.dependencies.repository.degraded(preview.id, error, {
            phase: preview.status === 'active' ? 'periodic_route_verification' : 'route_verification',
          }),
        )
      }
    }
  }

  private async recoverApplying(
    preview: PreviewRecord,
    observed: CaddyManagedRouteEntry | undefined,
  ): Promise<ApplyRecoveryResult | null> {
    if (preview.status !== 'applying') {
      return {
        preview,
        continueReconciliation: true,
      }
    }
    const decision = recoverApply(preview, this.observedDigest(observed))
    switch (decision.kind) {
      case 'pending_applied':
        return {
          preview: this.changed(await this.dependencies.repository.applied(preview.id)),
          continueReconciliation: true,
        }
      case 'current_retained':
        return {
          preview: this.changed(
            await this.dependencies.repository.rejectApply(
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
      case 'absent':
        await this.cleanup(
          preview,
          new IncusError(
            'Applying branch preview has no observed Caddy route and cannot prove the pending mutation outcome.',
            'CONFLICT',
          ),
          {
            phase: 'recover_applying_absent_configuration',
          },
        )
        return null
      case 'unknown':
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
  }

  private async recoverRemoving(preview: PreviewRecord, observed: CaddyManagedRouteEntry | undefined): Promise<void> {
    const decision = recoverRemoval(preview, this.observedDigest(observed))
    switch (decision.kind) {
      case 'absent':
        this.changed(await this.dependencies.repository.inactive(preview.id))
        return
      case 'current_retained':
        this.changed(
          await this.dependencies.repository.rejectRemoval(
            preview.id,
            new IncusError(
              'Caddy preview removal did not take effect and retained its known current route.',
              'CONFLICT',
            ),
            {
              phase: 'recover_removing_current_configuration',
            },
          ),
        )
        return
      case 'unknown':
        await this.cleanup(
          preview,
          new IncusError(
            'Removing branch preview no longer matches its durable current Caddy configuration.',
            'CONFLICT',
          ),
          {
            phase: 'recover_removing_mismatched_configuration',
          },
        )
    }
  }

  private async handleApplyFailure(preview: PreviewRecord, error: unknown): Promise<void> {
    if (!this.confirmedRejection(error)) {
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
    const decision = recoverApply(preview, this.observedDigest(observed))
    if (decision.kind === 'pending_applied') {
      this.changed(await this.dependencies.repository.applied(preview.id))
      return
    }
    if (decision.kind === 'current_retained') {
      this.changed(
        await this.dependencies.repository.rejectApply(preview.id, error, {
          phase: 'apply_caddy_route_rejected',
        }),
      )
      return
    }
    if (decision.kind === 'absent' && preview.currentConfigurationDigest === null) {
      this.changed(
        await this.dependencies.repository.rejectApply(preview.id, error, {
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
    if (!this.confirmedRejection(error)) {
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

  private async cleanup(preview: PreviewRecord, error: unknown, context: Record<string, unknown>): Promise<void> {
    if (preview.status === 'cleanup_required') {
      return
    }
    const transition = await this.dependencies.repository.cleanup(preview, error, {
      previewId: preview.id,
      capsuleId: preview.capsuleId,
      branchId: preview.branchId,
      applicationName: preview.applicationName,
      ...context,
    })
    if (transition.changed) {
      this.changed(transition.preview)
    }
  }

  private changed(preview: PreviewRecord): PreviewRecord {
    this.dependencies.events.changed(preview)
    return preview
  }

  private find(state: CaddyRoutesState, routeId: string): CaddyManagedRouteEntry | undefined {
    return state.routes.find(route => route.id === routeId)
  }

  private observedDigest(route: CaddyManagedRouteEntry | undefined): string | null {
    return route ? digestCapsuleRouteConfiguration(route.route) : null
  }

  private matchesPlan(route: CaddyManagedRouteEntry, plan: PreviewPlan): boolean {
    return this.observedDigest(route) === plan.configurationDigest
  }

  private matchesCurrent(route: CaddyManagedRouteEntry, preview: PreviewRecord): boolean {
    return (
      preview.currentConfigurationDigest !== null && this.observedDigest(route) === preview.currentConfigurationDigest
    )
  }

  private confirmedRejection(error: unknown): boolean {
    return error instanceof CaddyError && error.outcome !== CaddyMutationOutcome.UNKNOWN
  }

  private eligible(branch: PreviewBranch): boolean {
    return (
      branch.lifecycleStatus === 'active' &&
      branch.archivedAt === null &&
      branch.status === 'online' &&
      branch.runtimeIp !== null &&
      !branch.operationBlocked
    )
  }
}
