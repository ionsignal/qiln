import { RECIPE } from '../../../host/zfs/recipe'
import { ZFS_SPEC, type StepAction } from '../../../host/zfs/spec'
import { InstallerError, type DiagnosticFact } from '../../../diagnostic/error'
import { inspectHost } from '../../../host/zfs/inspect'
import { readLayout } from '../../../host/zfs/live'
import { planOf, releasePlanOf } from '../../../host/zfs/plan'
import { apply } from '../../../host/zfs/apply'
import {
  DEFAULT_POLICY,
  type ApprovedPlan,
  type Observation,
  type Plan,
  type RecordedPool,
  type ZfsTarget,
} from '../../../host/zfs/types'
import { verify } from '../../../host/zfs/verify'
import { StepJournal } from '../journal/steps'
import { prepareRetry } from '../retry'
import { poolState, prepared, requireNotStuck, staged, zfsFacts } from './facts'
import { actionsOf, establishesPool, type ZfsRecord } from './types'
import * as deployments from '../records'
import * as records from './records'
import type { ProgressSink } from '../observe/progress'
import type { Remote } from '../../../transport/ssh/connections'
import type { Dir } from '../../../state/files'
import type { Deployment } from '../types'

/**
 * The plans that concern the pool itself. The software scope stops before them.
 */
const STORAGE_PLANS: readonly Plan['kind'][] = ['create', 'import', 'mount', 'ready']

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

type ZfsJournal = StepJournal<ZfsRecord, ApprovedPlan, StepAction>

/**
 * Coordinates ZFS preparation under the AWS-operation lock held by the command.
 * Per step: authorization is persisted, then the fence, then the script runs,
 * then its completion or refusal is persisted, then a fresh inspection must
 * agree before `verifiedAt` is persisted. Nothing is replayed, resumed, or
 * rolled back, and an interrupted step stays open as evidence. SSH uncertainty
 * never affects the AWS child termination, because the durable ZFS guards keep
 * blocking instead.
 */
export class ZfsPreparer {
  private constructor(
    private readonly context: Context,
    private readonly journal: ZfsJournal,
  ) {}

  public static async open(context: Context): Promise<ZfsPreparer> {
    const { root, deployment, remote, hooks } = context
    const directory = await deployments.directoryOf(root, deployment.id)
    const record = (await records.read(directory, deployment)) ?? records.blank(deployment)
    if (record === null) {
      throw new InstallerError({
        code: 'INTERNAL_ERROR',
      })
    }
    requireNotStuck(record, deployment.id)
    const journal: ZfsJournal = new StepJournal({
      record,
      save: next => records.save(root, directory, deployment, next),
      recipe: RECIPE,
      failureCode: 'ZFS_STEP_FAILED',
      retry: prepareRetry(deployment.id),
      task: action => ({ kind: 'zfs', action }),
      run: (plan, action) => apply(remote, plan, action),
      approve: plan => hooks.approve(plan),
      progress: hooks.progress,
    })
    return new ZfsPreparer(context, journal)
  }

  private get retry(): string {
    return prepareRetry(this.context.deployment.id)
  }

  /**
   * This record's own pool evidence is newer than what the lineage found at
   * open time, so it wins once a create or import step has been verified.
   */
  private recorded(): RecordedPool | null {
    const record = this.journal.record
    const { pool } = record
    const { deployment, recorded } = this.context
    return pool === null
      ? recorded
      : {
          name: pool.name,
          guid: pool.guid,
          datasets: pool.datasets,
          deployment: deployment.id,
          staged: staged(record),
          ready: prepared(record),
        }
  }

  /**
   * Verifies a step left returned by an earlier run, then plans from fresh
   * evidence. Each approval covers only the plan displayed with it, so a plan
   * that changed mid-run, such as runtime ARC after a package-started module
   * load, asks again. The package step always ends its approval: the remaining
   * steps are re-planned from the post-install observation and need a fresh
   * approval, and a prerequisite approval never authorizes the storage plan.
   * The same holds for the storage plan and the mount of the state dataset,
   * which is planned afresh once the pool is created or imported with its scrub
   * timer enabled. The `software` scope stops as soon as the next plan concerns
   * the pool itself, without displaying it, so Incus software can be prepared
   * while no pool is mounted. The `storage` scope continues until the pool is
   * imported with its scrub timer enabled and its state dataset mounted. Returns
   * how many steps were applied.
   */
  public async run(signal: AbortSignal, scope: 'software' | 'storage'): Promise<number> {
    const { target, hooks, deployment } = this.context
    let observation = (await this.settleReturned()) ?? (await this.inspect())
    let applied = 0
    while (true) {
      const plan = planOf(observation, target, DEFAULT_POLICY, this.recorded())
      if (scope === 'software' && STORAGE_PLANS.includes(plan.kind)) {
        return applied
      }
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
        case 'import':
        case 'mount': {
          const authorization = await this.journal.authorize(plan)
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
   * Verifies a step left returned by an earlier run from a fresh inspection,
   * before any release is planned. This is accounting only: nothing is rerun,
   * and it needs no approval. Returns whether a step was verified.
   */
  public async settle(): Promise<boolean> {
    return (await this.settleReturned()) !== null
  }

  /**
   * Freshly checks the recorded pool before AWS removal. A pool observed
   * imported is cleanly exported under its own approval, after its state
   * dataset is unmounted when that is mounted. A pool observed absent is
   * accepted only when the evidence already records its verified export, and
   * records nothing itself, so no no-op export is ever recorded. Only called
   * when a pool is recorded as imported or exported.
   */
  public async release(signal: AbortSignal): Promise<void> {
    const { target, hooks } = this.context
    const observation = (await this.settleReturned()) ?? (await this.inspect())
    const recorded = this.recorded()
    if (recorded === null) {
      throw new InstallerError({
        code: 'INTERNAL_ERROR',
        retry: this.retry,
      })
    }
    const plan = releasePlanOf(observation, target, recorded, poolState(this.journal.record) === 'exported')
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
        const authorization = await this.journal.authorize(plan)
        for (const action of actionsOf(plan)) {
          await this.step(authorization, plan, action, signal)
        }
      }
    }
  }

  /**
   * The inspection reports on the pool the plan names, else on the recorded
   * one, else on the policy default. It asks about the approved packages too,
   * so the whole frozen transaction is checked and not only the direct
   * prerequisite.
   */
  private async inspect(plan?: ApprovedPlan): Promise<Observation> {
    const pool =
      plan === undefined || plan.kind === 'prerequisites'
        ? (this.recorded()?.name ?? DEFAULT_POLICY.poolName)
        : plan.pool
    const packages = plan?.kind === 'prerequisites' ? plan.install.map(change => change.name) : []
    return await inspectHost(this.context.remote, pool, packages)
  }

  private step(authorization: string, plan: ApprovedPlan, action: StepAction, signal: AbortSignal): Promise<Observation> {
    return this.journal.step(authorization, plan, action, signal, () => this.verified(plan, action))
  }

  /**
   * A verified create, import, or dataset step is persisted together with the
   * pool evidence it establishes, so the evidence never exists without its
   * verified step. The identity recorded by an earlier verified create is what
   * the dataset and scrub steps of that pool must still find.
   */
  private async verified(plan: ApprovedPlan, action: StepAction): Promise<Observation> {
    const record = this.journal.record
    const observation = await this.inspect(plan)
    if (!verify(action, plan, observation, record.pool)) {
      throw new InstallerError({
        code: 'ZFS_PREPARATION_UNRESOLVED',
        facts: [['Deployment', this.context.deployment.id], ...zfsFacts(record)],
        retry: this.retry,
      })
    }
    await this.journal.amend({ verifiedAt: new Date().toISOString() }, this.poolEvidence(plan, action, observation))
    return observation
  }

  private poolEvidence(plan: ApprovedPlan, action: StepAction, observation: Observation): Partial<ZfsRecord> {
    if (action === 'create-datasets') {
      const { pool } = this.journal.record
      const datasets = plan.kind === 'create' ? readLayout(observation, plan.pool) : null
      if (pool === null || datasets === null) {
        throw new InstallerError({
          code: 'INTERNAL_ERROR',
        })
      }
      return { pool: { ...pool, datasets } }
    }
    if (!establishesPool(action)) {
      return {}
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
    return {
      pool: {
        name: plan.pool,
        guid,
        volumeId: plan.disk.volumeId,
        layout: ZFS_SPEC.layout.revision,
        datasets: plan.kind === 'import' ? plan.datasets : null,
        observedAt: observation.observedAt,
      },
    }
  }

  /**
   * A step that exited zero but was never verified is accounting work, not
   * replay: only a fresh inspection is needed.
   */
  private settleReturned(): Promise<Observation | null> {
    return this.journal.settle((plan, action) => this.verified(plan, action))
  }
}
