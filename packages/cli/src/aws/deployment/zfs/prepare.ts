import { RECIPE } from '../../../host/zfs/recipe'
import { ZFS_SPEC, type StepAction } from '../../../host/zfs/spec'
import { InstallerError, type DiagnosticFact } from '../../../diagnostic/error'
import { inspectHost } from '../../../host/zfs/inspect'
import { readLayout } from '../../../host/zfs/live'
import { planOf, releasePlanOf } from '../../../host/zfs/plan'
import { apply } from '../../../host/zfs/apply'
import {
  DEFAULT_POLICY,
  createsDatasets,
  type ApprovedPlan,
  type Observation,
  type Plan,
  type PrerequisitePlan,
  type RecordedPool,
  type ZfsTarget,
} from '../../../host/zfs/types'
import { verify } from '../../../host/zfs/verify'
import { StepJournal } from '../journal/runner'
import { prepareRetry } from '../retry'
import { poolState, prepared, requireNotStuck, staged, zfsFacts } from './facts'
import { actionsOf, establishesPool, nextApproved, type ZfsRecord } from './types'
import * as deployments from '../records'
import * as records from './records'
import type { ProgressSink } from '../observe/progress'
import type { Remote } from '../../../transport/ssh/connections'
import type { Dir } from '../../../state/files'
import type { Deployment } from '../types'

/**
 * The plans that concern the pool itself. The software scope stops before them.
 */
const STORAGE_PLANS: readonly Plan['kind'][] = ['create', 'import', 'ready']

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
 * The live approval of a prerequisite plan within one `run`, with the actions it
 * has run. It exists only for the process and is never durable authority: the
 * approved plan is read back from the retained authorization.
 */
interface PrerequisiteApproval {
  authorization: string
  done: StepAction[]
}

interface Continuation {
  approved: PrerequisitePlan
  action: StepAction
}

function refusal(reasons: readonly string[], retry: string): InstallerError {
  return new InstallerError({
    code: 'ZFS_PLAN_REFUSED',
    facts: reasons.map((reason): DiagnosticFact => ['Reason', reason]),
    retry,
  })
}

/**
 * Coordinates ZFS preparation under the AWS-operation lock held by the command.
 * Per step: authorization persisted, fence persisted, script run, outcome
 * persisted, then a fresh inspection must agree before `verifiedAt` is
 * persisted. Nothing is replayed, resumed, or rolled back, and an interrupted
 * step stays open as evidence. SSH uncertainty never affects the AWS child
 * termination, because the durable ZFS guards keep blocking instead.
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
      run: (plan, action, current) => apply(remote, plan, action, current.pool),
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
  private recordedPool(): RecordedPool | null {
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
   * evidence. Each approval covers only the plan displayed with it. A
   * prerequisite approval is planned again after every verified step and
   * continues without a new prompt only while the fresh plan installs no
   * further packages, keeps the approved ARC limit, and needs only listed
   * actions that have not run yet. The `software` scope stops as soon as the
   * next plan concerns the pool itself, without displaying it, so Incus
   * software can be prepared while no pool is mounted. The `storage` scope
   * continues until the pool is imported with its scrub timer enabled and its
   * state dataset mounted. Returns how many steps were applied.
   */
  public async run(signal: AbortSignal, scope: 'software' | 'storage'): Promise<number> {
    const { target, hooks, deployment } = this.context
    let observation = (await this.settleReturned()) ?? (await this.inspect())
    let applied = 0
    let approval: PrerequisiteApproval | null = null
    while (true) {
      const plan = planOf(observation, target, DEFAULT_POLICY, this.recordedPool())
      if (scope === 'software' && STORAGE_PLANS.includes(plan.kind)) {
        return applied
      }
      if (approval !== null) {
        const next = this.resume(approval, plan)
        if (next !== null) {
          observation = await this.step(approval.authorization, next.approved, next.action, signal)
          approval.done.push(next.action)
          applied += 1
          continue
        }
        approval = null
      }
      hooks.show(observation, plan)
      switch (plan.kind) {
        case 'refused':
          throw refusal(plan.reasons, this.retry)
        case 'reboot':
          throw new InstallerError({
            code: 'ZFS_REBOOT_REQUIRED',
            facts: [['Deployment', deployment.id]],
            retry: this.retry,
          })
        case 'ready':
          return applied
        case 'prerequisites': {
          const authorization = await this.journal.authorize(plan)
          const [action] = actionsOf(plan)
          observation = await this.step(authorization, plan, action, signal)
          approval = { authorization, done: [action] }
          applied += 1
          break
        }
        case 'create':
        case 'import':
          observation = await this.execute(plan, observation, signal)
          applied += actionsOf(plan).length
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
   * records nothing itself. Only called when a pool is recorded as imported or
   * exported.
   */
  public async release(signal: AbortSignal): Promise<void> {
    const { target, hooks } = this.context
    const observation = (await this.settleReturned()) ?? (await this.inspect())
    const pool = this.recordedPool()
    if (pool === null) {
      throw new InstallerError({
        code: 'INTERNAL_ERROR',
        retry: this.retry,
      })
    }
    const plan = releasePlanOf(observation, target, pool, poolState(this.journal.record) === 'exported')
    hooks.show(observation, plan)
    switch (plan.kind) {
      case 'refused':
        throw refusal(plan.reasons, this.retry)
      case 'absent':
        return
      case 'export':
        await this.execute(plan, observation, signal)
    }
  }

  /**
   * One approval and every step it covers, in order. Returns the observation
   * that verified the last step.
   */
  private async execute(plan: ApprovedPlan, from: Observation, signal: AbortSignal): Promise<Observation> {
    const authorization = await this.journal.authorize(plan)
    let latest = from
    for (const action of actionsOf(plan)) {
      latest = await this.step(authorization, plan, action, signal)
    }
    return latest
  }

  /**
   * The next action that a live approval still covers, judged against the fresh
   * plan. The approved plan is read back from its retained authorization, so
   * continuation never rests on a retained request.
   */
  private resume(approval: PrerequisiteApproval, fresh: Plan): Continuation | null {
    const approved = this.journal.record.authorizations.find(({ id }) => id === approval.authorization)?.plan
    if (approved?.kind !== 'prerequisites') {
      return null
    }
    const action = nextApproved(fresh, approved, approval.done)
    return action === null ? null : { approved, action }
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
        ? (this.recordedPool()?.name ?? DEFAULT_POLICY.poolName)
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
   * the dataset, scrub, and mount steps of that pool must still find.
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
      const datasets = createsDatasets(plan) ? readLayout(observation, plan.pool) : null
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
