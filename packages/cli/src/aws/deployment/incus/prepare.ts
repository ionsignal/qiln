import { RECIPE } from '../../../host/incus/recipe'
import { sameJson } from '../../../json'
import { verify } from '../../../host/incus/verify'
import { apply } from '../../../host/incus/apply'
import { baselineOf } from '../../../host/incus/baseline'
import { inspectHost } from '../../../host/incus/inspect'
import { planOf, releasePlanOf, softwarePlanOf } from '../../../host/incus/plan'
import { preseedOf, type Preseed } from '../../../host/incus/preseed'
import { InstallerError, type DiagnosticFact } from '../../../diagnostic/error'
import {
  artifactsOf,
  closureOf,
  incusFacts,
  opened,
  requireNotStuck,
  retainedPreseed,
  storageReleased,
} from './facts'
import {
  actionsOf,
  identityOf,
  type ApprovedPlan,
  type CapturePlan,
  type IncusTarget,
  type InitializePlan,
  type InspectTarget,
  type Observation,
  type OpenPlan,
  type PackageChange,
  type Plan,
  type Progress,
  type ReleaseTarget,
  type RestorePlan,
  type Retained,
  type SelectPlan,
  type SoftwareTarget,
} from '../../../host/incus/types'
import { StepJournal } from '../journal/runner'
import { prepareRetry } from '../retry'
import * as deployments from '../records'
import * as records from './records'
import type { ProgressSink } from '../observe/progress'
import type { IncusAction } from '../../../host/incus/spec'
import type { Remote } from '../../../transport/ssh/connections'
import type { Dir } from '../../../state/files'
import type { Deployment } from '../types'
import type { IncusRecord } from './types'

type Scope = Pick<InspectTarget, 'pool' | 'account'> & { retained?: Retained | null }
type IncusJournal = StepJournal<IncusRecord, ApprovedPlan, IncusAction>

export interface Hooks {
  show(observation: Observation, plan: Plan): void
  approve(plan: ApprovedPlan): Promise<void>
  progress?: ProgressSink
}

export interface Context {
  root: Dir
  deployment: Deployment
  remote: Remote
  hooks: Hooks
}

function refusal(reasons: readonly string[], retry: string): InstallerError {
  return new InstallerError({
    code: 'AWS_INCUS_PLAN_REFUSED',
    facts: reasons.map((reason): DiagnosticFact => ['Reason', reason]),
    retry,
  })
}

function packageNamesOf(plan: ApprovedPlan | undefined): string[] {
  if (plan?.kind === 'packages') {
    return plan.install.map(change => change.name)
  }
  if (plan?.kind === 'restore') {
    return plan.manifest.map(entry => entry.name)
  }
  return []
}

/**
 * Coordinates Incus preparation under the AWS-operation lock held by the
 * command. Per step: authorization persisted, fence persisted, script run,
 * outcome persisted, then a fresh inspection must agree before `verifiedAt` is
 * persisted. Nothing is replayed, resumed, or rolled back, and an interrupted
 * step stays open as evidence.
 *
 * Stages, each planned from a fresh inspection and approved on its own:
 * closing, with its repository on a fresh host, the version selection and
 * packages of a fresh host, activation, and release. Selection grants nothing:
 * it only chooses the build whose transaction the packages plan then freezes. A
 * preserved host only closes in the software stage, and never touches a
 * repository. Activation is the capture of the installed package files onto the
 * artifacts dataset (a fresh installation only), or the restore of the retained
 * package files from it (a preserved installation whose packages are missing),
 * then the open together with the storage-identity guard when it is not yet
 * installed, then initialization (or the reopen of a preserved installation,
 * which never initializes), then socket access. The first verified
 * initialization, or first verified open of a preserved installation, persists
 * the baseline and server identity once; later reopens verify against them.
 * Captures, restores, opens and initializations are planned again after approval
 * and must be unchanged before anything is persisted.
 */
export class IncusPreparer {
  private pins: PackageChange[] | null = null

  private constructor(
    private readonly context: Context,
    private readonly journal: IncusJournal,
  ) {}

  public static async open(context: Context): Promise<IncusPreparer> {
    const { root, deployment, remote, hooks } = context
    const directory = await deployments.directoryOf(root, deployment.id)
    const record = (await records.read(directory, deployment)) ?? records.blank(deployment)
    if (record === null) {
      throw new InstallerError({
        code: 'INTERNAL_ERROR',
      })
    }
    requireNotStuck(record, deployment.id)
    const journal: IncusJournal = new StepJournal({
      record,
      save: next => records.save(root, directory, deployment, next),
      recipe: RECIPE,
      failureCode: 'AWS_INCUS_STEP_FAILED',
      retry: prepareRetry(deployment.id),
      task: action => ({ kind: 'incus', action }),
      run: (plan, action) => apply(remote, plan, action),
      approve: plan => hooks.approve(plan),
      progress: hooks.progress,
    })
    return new IncusPreparer(context, journal)
  }

  private get retry(): string {
    return prepareRetry(this.context.deployment.id)
  }

  private get progress(): Progress {
    const record = this.journal.record
    return {
      opened: opened(record),
      retained: retainedPreseed(record),
      baseline: record.baseline,
      pins: this.pins,
      closure: closureOf(record),
      artifacts: artifactsOf(record),
    }
  }

  /**
   * The software stage, which needs no pool. Verifies a step left returned by an
   * earlier run, then plans from fresh evidence. Each approval runs only the
   * steps of the plan displayed with it. A fresh host selects its Incus build
   * once the repository lists are refreshed, which needs no approval. The
   * `repository` scope stops as soon as the next plan is the selection, the
   * packages, or nothing, without displaying it, so the host is closed with its
   * repository in place before any ZFS or package effect. The `packages` scope
   * continues until the host is closed and the approved packages are installed.
   * A preserved host is only closed here, and its packages are restored by the
   * activation stage. Returns how many steps were applied.
   */
  public async prepareSoftware(
    target: SoftwareTarget,
    signal: AbortSignal,
    through: 'repository' | 'packages',
  ): Promise<number> {
    const scope: Scope = { pool: null, account: target.account, retained: target.retained }
    let observation = (await this.settleReturned(scope)) ?? (await this.inspect(scope))
    let applied = 0
    while (true) {
      const plan = softwarePlanOf(observation, target, this.progress)
      if (plan.kind === 'select') {
        if (through === 'repository') {
          return applied
        }
        observation = await this.select(plan, scope)
        continue
      }
      if (plan.kind === 'software' || (through === 'repository' && plan.kind === 'packages')) {
        return applied
      }
      this.context.hooks.show(observation, plan)
      if (plan.kind === 'refused') {
        throw refusal(plan.reasons, this.retry)
      }
      observation = await this.execute(plan, scope, observation, signal)
      applied += actionsOf(plan).length
    }
  }

  /**
   * The activation stage, which needs the recorded pool imported with its state
   * dataset mounted. Each approval covers only the plan displayed with it: the
   * capture of a fresh installation's package files or the restore of a
   * preserved installation's retained ones, the open (with its guard), the
   * initialization, and the socket access grant each ask again. The open is
   * planned whenever the daemon is not running, so a host that rebooted reopens
   * its recorded installation here. Returns how many steps were applied, and
   * stops once the approved configuration holds.
   */
  public async activate(target: IncusTarget, signal: AbortSignal): Promise<number> {
    const { hooks } = this.context
    const preseed = preseedOf(target.pool)
    let observation = (await this.settleReturned(target)) ?? (await this.inspect(target))
    let applied = 0
    while (true) {
      const plan = planOf(observation, target, preseed, this.progress)
      if (plan.kind === 'select') {
        observation = await this.select(plan, target)
        continue
      }
      hooks.show(observation, plan)
      switch (plan.kind) {
        case 'refused':
          throw refusal(plan.reasons, this.retry)
        case 'ready':
          return applied
        case 'close':
        case 'repository':
        case 'packages':
        case 'capture':
        case 'restore':
        case 'open':
        case 'access':
        case 'initialize': {
          const recheck =
            plan.kind === 'initialize' || plan.kind === 'open' || plan.kind === 'capture' || plan.kind === 'restore'
              ? () => this.confirmCurrent(plan, target, preseed)
              : undefined
          observation = await this.execute(plan, target, observation, signal, recheck)
          applied += actionsOf(plan).length
        }
      }
    }
  }

  /**
   * Releases Incus before the separate ZFS export. A fresh observation decides:
   * units that are all positively inactive need nothing when a verified release
   * is already retained, and nothing is recorded for that. Inactive units
   * without that evidence are refused. Otherwise the whole release runs under
   * one approval: the workloads are stopped, then the daemon is stopped and
   * every unit masked. Incus is not queried afterwards.
   */
  public async release(target: ReleaseTarget, signal: AbortSignal): Promise<void> {
    const { hooks } = this.context
    const observation = (await this.settleReturned(target)) ?? (await this.inspect(target))
    const plan = releasePlanOf(observation, target, storageReleased(this.journal.record))
    hooks.show(observation, plan)
    switch (plan.kind) {
      case 'refused':
        throw refusal(plan.reasons, this.retry)
      case 'stopped':
        return
      case 'release':
        await this.execute(plan, target, observation, signal)
    }
  }

  /**
   * Adopts the selected build and inspects again, so the simulation covers
   * exactly those versions.
   */
  private async select(plan: SelectPlan, scope: Scope): Promise<Observation> {
    this.pins = plan.pins
    return await this.inspect(scope)
  }

  /**
   * One approval and every step it covers, in order. Returns the observation
   * that verified the last step. `recheck` runs after approval and before
   * anything is persisted.
   */
  private async execute(
    plan: ApprovedPlan,
    scope: Scope,
    from: Observation,
    signal: AbortSignal,
    recheck?: () => Promise<void>,
  ): Promise<Observation> {
    const authorization = await this.journal.authorize(plan, recheck)
    let latest = from
    for (const action of actionsOf(plan)) {
      latest = await this.step(authorization, plan, action, scope, signal)
    }
    return latest
  }

  /**
   * The inspection reports on the pool the approved plan names, else on the
   * scope's, which is none during the software stage. It asks about the
   * approved packages too, so the whole frozen transaction is checked and not
   * only the direct packages. The staged package files and index records are
   * only inspected for the closure of the packages plan being verified, which
   * is not recorded as verified yet, or for a fresh installation whose capture
   * is still pending, because hashing them is not free.
   */
  private async inspect(scope: Scope, plan?: ApprovedPlan): Promise<Observation> {
    const { closure, artifacts } = this.progress
    const pool = plan !== undefined && 'pool' in plan ? plan.pool : scope.pool
    const captureClosure = scope.retained === null && artifacts === null ? closure : null
    const stagedClosure = plan?.kind === 'packages' ? plan.install : captureClosure
    return await inspectHost(
      this.context.remote,
      { pool, account: scope.account, pins: this.pins, closure: stagedClosure },
      packageNamesOf(plan),
    )
  }

  /**
   * The operator may take a while to approve, so a capture, restore, open or
   * initialization is planned again from a fresh inspection, and the approved
   * plan must still be exactly what is planned now. This refuses before
   * anything is persisted.
   */
  private async confirmCurrent(
    approved: CapturePlan | RestorePlan | InitializePlan | OpenPlan,
    target: IncusTarget,
    preseed: Preseed,
  ): Promise<void> {
    const current = planOf(await this.inspect(target), target, preseed, this.progress)
    if (current.kind === 'refused') {
      throw refusal(current.reasons, this.retry)
    }
    if (!sameJson(current, approved)) {
      throw refusal(
        ['The host changed after the plan was displayed, so the approved step was not applied.'],
        this.retry,
      )
    }
  }

  private step(
    authorization: string,
    plan: ApprovedPlan,
    action: IncusAction,
    scope: Scope,
    signal: AbortSignal,
  ): Promise<Observation> {
    return this.journal.step(authorization, plan, action, signal, () => this.verified(plan, action, scope))
  }

  private unresolved(): InstallerError {
    return new InstallerError({
      code: 'AWS_INCUS_PREPARATION_UNRESOLVED',
      facts: [['Deployment', this.context.deployment.id], ...incusFacts(this.journal.record)],
      retry: this.retry,
    })
  }

  /**
   * The first initialization, or the first open of a preserved installation,
   * establishes the software baseline and the standalone server identity, so
   * neither exists without its step. A preserved open keeps the retained
   * subordinate-ID ranges, so extra ranges never ratchet into the record. Once a
   * baseline is recorded, later opens of the same deployment write nothing, so
   * benign drift in unpinned packages never rewrites it.
   */
  private established(plan: ApprovedPlan, action: IncusAction, observation: Observation): Partial<IncusRecord> {
    if (this.journal.record.baseline !== null) {
      return {}
    }
    const retained = plan.kind === 'open' ? plan.retained : null
    const establishes = action === 'initialize' || (action === 'open' && retained !== null)
    if (!establishes) {
      return {}
    }
    const baseline = baselineOf(observation, retained?.baseline ?? null)
    const identity = identityOf(observation)
    if (baseline === null || identity === null) {
      throw this.unresolved()
    }
    return { baseline, identity }
  }

  private async verified(plan: ApprovedPlan, action: IncusAction, scope: Scope): Promise<Observation> {
    const observation = await this.inspect(scope, plan)
    if (!verify(action, plan, observation)) {
      throw this.unresolved()
    }
    await this.journal.amend({ verifiedAt: new Date().toISOString() }, this.established(plan, action, observation))
    return observation
  }

  /**
   * A step that exited zero but was never verified is accounting work, not
   * replay: only a fresh inspection is needed.
   */
  private settleReturned(scope: Scope): Promise<Observation | null> {
    return this.journal.settle((plan, action) => this.verified(plan, action, scope))
  }
}
