import { randomUUID } from 'node:crypto'
import { RECIPE } from '../../../remote/zfs/recipe'
import { InstallerError, type DiagnosticFact } from '../../../diagnostic/error'
import { apply, type ApplyOutcome } from '../../../remote/zfs/apply'
import { inspectHost } from '../../../remote/zfs/inspect'
import { planOf, releasePlanOf } from '../../../remote/zfs/plan'
import {
  DEFAULT_POLICY,
  type ApprovedPlan,
  type Observation,
  type Plan,
  type RecordedPool,
  type ZfsTarget,
} from '../../../remote/zfs/types'
import { verify } from '../../../remote/zfs/verify'
import { checkCancellation } from '../../../terminal/prompts'
import { userId } from '../../host'
import { notify, withWaiting, type ProgressSink, type ProgressTask } from '../progress'
import { poolState, prepared, requireNotStuck, returned, zfsFacts } from './facts'
import { actionsOf, establishesPool, type ZfsAuthorization, type ZfsRecord, type ZfsStep } from './types'
import * as deployments from '../records'
import * as records from './records'
import type { StepAction } from '../../../remote/zfs/spec'
import type { Remote } from '../../../ssh/connections'
import type { Dir } from '../../../state/files'
import type { Deployment } from '../types'

/**
 * The command owns presentation and consent. `show` renders every plan the
 * moment it is derived, and `approve` resolves only when the operator approved
 * the plan that was just shown. The progress sink only observes.
 */
export interface Hooks {
  show(observation: Observation, plan: Plan): void
  approve(plan: ApprovedPlan): Promise<void>
  progress?: ProgressSink
}

export interface Context {
  root: Dir
  deployment: Deployment
  target: ZfsTarget
  recorded: RecordedPool | null
  remote: Remote
  hooks: Hooks
}

function failure(
  action: StepAction,
  outcome: Exclude<ApplyOutcome, { kind: 'returned' }>,
  retry: string,
): InstallerError {
  if (outcome.cause?.kind === 'cancelled') {
    return outcome.cause
  }
  return new InstallerError({
    code: 'ZFS_STEP_FAILED',
    facts: [
      ['Step', action],
      [
        'Outcome',
        outcome.kind === 'refused'
          ? 'refused; the step had no effect'
          : 'uncertain; the step may have run partly or fully',
      ],
      ['Reason', outcome.reason],
      ...(outcome.cause?.facts ?? []),
    ],
    retry,
  })
}

/**
 * Coordinates ZFS preparation under the AWS-operation lock held by the
 * command. Per step: authorization is persisted, then the fence, then the
 * script runs, then its completion or refusal is persisted, then a fresh
 * inspection must agree before `verifiedAt` is persisted. Nothing is replayed,
 * resumed, or rolled back, and an interrupted step stays open as evidence.
 * SSH uncertainty never affects the AWS child termination, because the
 * durable ZFS guards keep blocking instead.
 */
export class Preparer {
  private constructor(
    private readonly context: Context,
    private readonly directory: Dir,
    private evidence: ZfsRecord,
  ) {}

  public static async open(context: Context): Promise<Preparer> {
    const { root, deployment } = context
    const directory = await deployments.directoryOf(root, deployment.id)
    const evidence = (await records.read(directory, deployment)) ?? records.blank(deployment)
    if (evidence === null) {
      throw new InstallerError({
        code: 'INTERNAL_ERROR',
      })
    }
    requireNotStuck(evidence, deployment.id)
    return new Preparer(context, directory, evidence)
  }

  private get retry(): string {
    return `qiln aws deployment prepare --id ${this.context.deployment.id}`
  }

  /**
   * This record's own pool evidence is newer than what the lineage found at
   * open time, so it wins once a create or import step has been verified.
   */
  private recorded(): RecordedPool | null {
    const { pool } = this.evidence
    const { deployment, recorded } = this.context
    return pool === null
      ? recorded
      : { name: pool.name, guid: pool.guid, deployment: deployment.id, ready: prepared(this.evidence) }
  }

  /**
   * Verifies a step left returned by an earlier run, then plans from fresh
   * evidence. Each approval covers only the plan displayed with it, so a plan
   * that changed mid-run, such as runtime ARC after a package-started module
   * load, asks again. The package step always ends its approval: the remaining
   * steps are re-planned from the post-install observation and need a fresh
   * approval, and a prerequisite approval never authorizes the storage plan.
   * Returns how many steps were applied, and stops once the pool is imported
   * with its scrub timer enabled.
   */
  public async run(signal: AbortSignal): Promise<number> {
    const { target, hooks, deployment } = this.context
    let observation = (await this.settleReturned()) ?? (await this.inspect())
    let applied = 0
    while (true) {
      const plan = planOf(observation, target, DEFAULT_POLICY, this.recorded())
      hooks.show(observation, plan)
      switch (plan.kind) {
        case 'refused':
          throw new InstallerError({
            code: 'ZFS_PLAN_REFUSED',
            facts: plan.reasons.map((reason): DiagnosticFact => ['Reason', reason]),
            retry: this.retry,
          })
        case 'reboot':
          throw new InstallerError({
            code: 'ZFS_REBOOT_REQUIRED',
            facts: [['Deployment', deployment.id]],
            retry: this.retry,
          })
        case 'ready':
          return applied
        case 'prerequisites':
        case 'create':
        case 'import': {
          const authorization = await this.authorize(plan)
          for (const action of actionsOf(plan)) {
            observation = await this.step(authorization, plan, action, signal)
            applied += 1
            // Installing packages can load the module and start ZFS services, so
            // the rest of this plan may be stale. The next iteration plans again
            // from the post-install observation.
            if (action === 'install-packages') {
              break
            }
          }
        }
      }
    }
  }

  /**
   * Freshly checks the recorded pool before AWS removal. A pool observed
   * imported is cleanly exported under its own approval. A pool observed absent
   * is accepted only when the evidence already records its verified export, and
   * records nothing itself, so no no-op export is ever recorded. Only called
   * when a pool is recorded as imported or exported.
   */
  public async release(signal: AbortSignal): Promise<void> {
    const { target, hooks } = this.context
    const recorded = this.recorded()
    if (recorded === null) {
      throw new InstallerError({
        code: 'INTERNAL_ERROR',
        retry: this.retry,
      })
    }
    const observation = (await this.settleReturned()) ?? (await this.inspect())
    const plan = releasePlanOf(observation, target, recorded, poolState(this.evidence) === 'exported')
    hooks.show(observation, plan)
    switch (plan.kind) {
      case 'refused':
        throw new InstallerError({
          code: 'ZFS_PLAN_REFUSED',
          facts: plan.reasons.map((reason): DiagnosticFact => ['Reason', reason]),
          retry: this.retry,
        })
      case 'absent':
        return
      case 'export': {
        const authorization = await this.authorize(plan)
        await this.step(authorization, plan, 'export-pool', signal)
      }
    }
  }

  /**
   * The inspection reports on the pool the plan names, else on the recorded one,
   * else on the policy default. It asks about the approved packages too, so the
   * whole frozen transaction is checked and not only the direct prerequisite.
   */
  private async inspect(plan?: ApprovedPlan): Promise<Observation> {
    const pool =
      plan === undefined || plan.kind === 'prerequisites'
        ? (this.recorded()?.name ?? DEFAULT_POLICY.poolName)
        : plan.pool
    const packages = plan?.kind === 'prerequisites' ? plan.install.map(change => change.name) : []
    return await inspectHost(this.context.remote, pool, packages)
  }

  private async persist(changes: Partial<ZfsRecord>): Promise<void> {
    const next = { ...this.evidence, ...changes }
    await records.save(this.context.root, this.directory, this.context.deployment, next)
    this.evidence = next
  }

  private async amend(change: Partial<ZfsStep>, pool?: ZfsRecord['pool']): Promise<void> {
    const { steps } = this.evidence
    await this.persist({
      steps: [...steps.slice(0, -1), { ...steps[steps.length - 1], ...change }],
      ...(pool === undefined ? {} : { pool }),
    })
  }

  private async authorize(plan: ApprovedPlan): Promise<string> {
    await this.context.hooks.approve(plan)
    const authorization: ZfsAuthorization = {
      id: randomUUID(),
      approvedAt: new Date().toISOString(),
      approvedBy: { method: 'local-interactive', userId: userId() },
      recipe: { revision: RECIPE.revision, digest: RECIPE.digest },
      plan,
    }
    await this.persist({ authorizations: [...this.evidence.authorizations, authorization] })
    return authorization.id
  }

  private async step(
    authorization: string,
    plan: ApprovedPlan,
    action: StepAction,
    signal: AbortSignal,
  ): Promise<Observation> {
    const { remote, hooks } = this.context
    checkCancellation(signal)
    const task: ProgressTask = { kind: 'zfs', action }
    notify(hooks.progress, { phase: 'working', task })
    await this.persist({
      steps: [
        ...this.evidence.steps,
        {
          id: randomUUID(),
          authorization,
          action,
          fencedAt: new Date().toISOString(),
          completion: null,
          refusedAt: null,
          verifiedAt: null,
        },
      ],
    })
    const observation = await withWaiting(hooks.progress, task, async () => {
      await this.conclude(action, await apply(remote, plan, action))
      return await this.verified(plan, action)
    })
    notify(hooks.progress, { phase: 'verified', task })
    return observation
  }

  /**
   * Records what the script reported. A refusal or an unconfirmed outcome is
   * recorded and then thrown, so cancellation is classified before it
   * propagates. A step with no exit status stays open, which is uncertain.
   */
  private async conclude(action: StepAction, outcome: ApplyOutcome): Promise<void> {
    const at = new Date().toISOString()
    switch (outcome.kind) {
      case 'returned':
        await this.amend({ completion: { exitCode: 0, completedAt: at } })
        return
      case 'refused':
        await this.amend({ refusedAt: at })
        throw failure(action, outcome, this.retry)
      case 'uncertain':
        if (outcome.exitCode !== null) {
          await this.amend({ completion: { exitCode: outcome.exitCode, completedAt: at } })
        }
        throw failure(action, outcome, this.retry)
    }
  }

  /**
   * A verified create or import is persisted together with the pool evidence it
   * establishes, so the evidence never exists without its verified step. The
   * GUID recorded by an earlier verified create is what the scrub step of that
   * pool must still find.
   */
  private async verified(plan: ApprovedPlan, action: StepAction): Promise<Observation> {
    const observation = await this.inspect(plan)
    if (!verify(action, plan, observation, this.evidence.pool?.guid ?? null)) {
      throw new InstallerError({
        code: 'ZFS_PREPARATION_UNRESOLVED',
        facts: [['Deployment', this.context.deployment.id], ...zfsFacts(this.evidence)],
        retry: this.retry,
      })
    }
    await this.amend({ verifiedAt: new Date().toISOString() }, this.poolEvidence(plan, action, observation))
    return observation
  }

  private poolEvidence(
    plan: ApprovedPlan,
    action: StepAction,
    observation: Observation,
  ): NonNullable<ZfsRecord['pool']> | undefined {
    if (!establishesPool(action)) {
      return undefined
    }
    if (plan.kind !== 'create' && plan.kind !== 'import') {
      throw new InstallerError({
        code: 'INTERNAL_ERROR',
      })
    }
    const guid = observation.pools.imported.find(pool => pool.name === plan.pool)?.guid
    if (guid === undefined) {
      throw new InstallerError({
        code: 'INTERNAL_ERROR',
      })
    }
    return { name: plan.pool, guid, volumeId: plan.disk.volumeId, observedAt: observation.observedAt }
  }

  /**
   * A step that exited zero but was never verified is accounting work, not
   * replay: only a fresh inspection is needed.
   */
  private async settleReturned(): Promise<Observation | null> {
    const pending = returned(this.evidence).at(-1)
    if (pending === undefined) {
      return null
    }
    const plan = this.evidence.authorizations.find(({ id }) => id === pending.authorization)?.plan
    if (plan === undefined) {
      throw new InstallerError({
        code: 'INTERNAL_ERROR',
        retry: this.retry,
      })
    }
    return await this.verified(plan, pending.action)
  }
}
