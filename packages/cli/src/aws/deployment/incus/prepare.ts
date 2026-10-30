import { randomUUID } from 'node:crypto'
import { RECIPE } from '../../../host/incus/recipe'
import { userId } from '../../host'
import { sameJson } from '../../../json'
import { verify } from '../../../host/incus/verify'
import { apply } from '../../../host/incus/apply'
import { baselineOf } from '../../../host/incus/baseline'
import { inspectHost } from '../../../host/incus/inspect'
import { planOf, releasePlanOf, softwarePlanOf } from '../../../host/incus/plan'
import { preseedOf, type Preseed } from '../../../host/incus/preseed'
import { checkCancellation } from '../../../terminal/prompts'
import { InstallerError, type DiagnosticFact } from '../../../diagnostic/error'
import { notify, withWaiting, type ProgressSink, type ProgressTask } from '../progress'
import { incusFacts, opened, requireNotStuck, retainedPreseed, returned, storageReleased } from './facts'
import {
  actionsOf,
  identityOf,
  type ApprovedPlan,
  type IncusTarget,
  type InitializePlan,
  type InspectTarget,
  type Observation,
  type OpenPlan,
  type Plan,
  type Progress,
  type ReleaseTarget,
  type SoftwareTarget,
} from '../../../host/incus/types'
import * as deployments from '../records'
import * as records from './records'
import type { StepOutcome } from '../../../host/step'
import type { IncusAction } from '../../../host/incus/spec'
import type { Remote } from '../../../transport/ssh/connections'
import type { Dir } from '../../../state/files'
import type { Deployment } from '../types'
import type { IncusAuthorization, IncusRecord, IncusStep } from './types'

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

function failure(
  action: IncusAction,
  outcome: Exclude<StepOutcome, { kind: 'returned' }>,
  retry: string,
): InstallerError {
  if (outcome.cause?.kind === 'cancelled') {
    return outcome.cause
  }
  return new InstallerError({
    code: 'AWS_INCUS_STEP_FAILED',
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
 * Coordinates Incus preparation under the AWS-operation lock held by the
 * command. Per step: authorization is persisted, then the fence, then the
 * script runs, then its completion or refusal is persisted, then a fresh
 * inspection must agree before `verifiedAt` is persisted. Preparation runs in
 * two stages around the ZFS storage: the software stage closes the host and
 * installs the packages while no pool is mounted, and the activation stage
 * installs the storage-identity guard and opens the daemon on the mounted state
 * dataset. The verified initialization, or the verified open of a preserved
 * installation, is persisted together with the software baseline, the
 * subordinate-ID ranges, and the server identity it was verified against. An
 * open or initialization is also planned again from a fresh inspection after
 * approval, before anything is persisted. Nothing is replayed, resumed, or
 * rolled back, and an interrupted step stays open as evidence. A release is one
 * approval of two fenced steps, the workload stop and then the daemon release,
 * and it runs nothing when a verified release is already recorded and every unit
 * is inactive. It runs parallel to the ZFS preparer and shares only the journal
 * rules.
 */
export class IncusPreparer {
  private constructor(
    private readonly context: Context,
    private readonly directory: Dir,
    private evidence: IncusRecord,
  ) {}

  public static async open(context: Context): Promise<IncusPreparer> {
    const { root, deployment } = context
    const directory = await deployments.directoryOf(root, deployment.id)
    const evidence = (await records.read(directory, deployment)) ?? records.blank(deployment)
    if (evidence === null) {
      throw new InstallerError({
        code: 'INTERNAL_ERROR',
      })
    }
    requireNotStuck(evidence, deployment.id)
    return new IncusPreparer(context, directory, evidence)
  }

  private get retry(): string {
    return `qiln aws deployment prepare --id ${this.context.deployment.id}`
  }

  private get progress(): Progress {
    return { opened: opened(this.evidence), retained: retainedPreseed(this.evidence) }
  }

  /**
   * The software stage, which needs no pool and runs before any pool is
   * mounted. Verifies a step left returned by an earlier run, then plans from
   * fresh evidence. Each approval covers only the plan displayed with it, so the
   * masks, the repository, and the packages each ask again. Returns how many
   * steps were applied, and stops once the host is closed and the approved
   * packages are installed.
   */
  public async prepareSoftware(target: SoftwareTarget, signal: AbortSignal): Promise<number> {
    const inspected: InspectTarget = { ...target, pool: null }
    let observation = (await this.settleReturned(inspected)) ?? (await this.inspect(inspected))
    let applied = 0
    while (true) {
      const plan = softwarePlanOf(observation, target, this.progress)
      if (plan.kind === 'software') {
        return applied
      }
      this.context.hooks.show(observation, plan)
      if (plan.kind === 'refused') {
        throw refusal(plan.reasons, this.retry)
      }
      const authorization = await this.authorize(plan)
      for (const action of actionsOf(plan)) {
        observation = await this.step(authorization, plan, action, inspected, signal)
        applied += 1
      }
    }
  }

  /**
   * The activation stage, which needs the recorded pool imported with its state
   * dataset mounted. Plans from fresh evidence, and each approval covers only
   * the plan displayed with it, so the guard, the open, the initialization, and
   * the socket access grant each ask again. Returns how many steps were applied,
   * and stops once the approved configuration holds.
   */
  public async activate(target: IncusTarget, signal: AbortSignal): Promise<number> {
    const { hooks } = this.context
    const preseed = preseedOf(target.pool)
    let observation = (await this.settleReturned(target)) ?? (await this.inspect(target))
    let applied = 0
    while (true) {
      const plan = planOf(observation, target, preseed, this.progress)
      hooks.show(observation, plan)
      switch (plan.kind) {
        case 'refused':
          throw refusal(plan.reasons, this.retry)
        case 'ready':
          return applied
        case 'close':
        case 'repository':
        case 'packages':
        case 'guard':
        case 'open':
        case 'access':
        case 'initialize': {
          const recheck =
            plan.kind === 'initialize' || plan.kind === 'open'
              ? () => this.confirmCurrent(plan, target, preseed)
              : undefined
          const authorization = await this.authorize(plan, recheck)
          for (const action of actionsOf(plan)) {
            observation = await this.step(authorization, plan, action, target, signal)
            applied += 1
          }
        }
      }
    }
  }

  /**
   * Releases Incus before the separate ZFS export. A fresh observation decides:
   * units that are all positively inactive need nothing when a verified release
   * is already retained, and nothing is recorded for that. Inactive units
   * without that evidence are refused. Otherwise the whole release runs under
   * one approval: the workloads are stopped, and then the daemon is stopped and
   * every unit masked. Incus is not queried afterwards.
   */
  public async release(target: ReleaseTarget, signal: AbortSignal): Promise<void> {
    const { hooks } = this.context
    const observation = (await this.settleReturned(target)) ?? (await this.inspect(target))
    const plan = releasePlanOf(observation, target, storageReleased(this.evidence))
    hooks.show(observation, plan)
    switch (plan.kind) {
      case 'refused':
        throw refusal(plan.reasons, this.retry)
      case 'stopped':
        return
      case 'release': {
        const authorization = await this.authorize(plan)
        for (const action of actionsOf(plan)) {
          await this.step(authorization, plan, action, target, signal)
        }
      }
    }
  }

  /**
   * The inspection reports on the pool the approved plan names, else on the
   * target's, which is none during the software stage. It asks about the
   * approved packages too, so the whole frozen transaction is checked and not
   * only the direct packages.
   */
  private async inspect(target: InspectTarget, plan?: ApprovedPlan): Promise<Observation> {
    const pool = plan !== undefined && 'pool' in plan ? plan.pool : target.pool
    const approved = plan?.kind === 'packages' ? plan.install.map(change => change.name) : []
    return await inspectHost(this.context.remote, { ...target, pool }, approved)
  }

  /**
   * The operator may take a while to approve, so an open or initialization is
   * planned again from a fresh inspection, and the approved plan must still be
   * exactly what is planned now. This refuses before anything is persisted, so
   * a new invocation can try again.
   */
  private async confirmCurrent(
    approved: InitializePlan | OpenPlan,
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

  private async persist(changes: Partial<IncusRecord>): Promise<void> {
    const next = { ...this.evidence, ...changes }
    await records.save(this.context.root, this.directory, this.context.deployment, next)
    this.evidence = next
  }

  private async amend(change: Partial<IncusStep>, record: Partial<IncusRecord> = {}): Promise<void> {
    const { steps } = this.evidence
    await this.persist({
      steps: [...steps.slice(0, -1), { ...steps[steps.length - 1], ...change }],
      ...record,
    })
  }

  private async authorize(plan: ApprovedPlan, recheck?: () => Promise<void>): Promise<string> {
    await this.context.hooks.approve(plan)
    await recheck?.()
    const authorization: IncusAuthorization = {
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
    action: IncusAction,
    target: InspectTarget,
    signal: AbortSignal,
  ): Promise<Observation> {
    const { remote, hooks } = this.context
    checkCancellation(signal)
    const task: ProgressTask = { kind: 'incus', action }
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
      return await this.verified(plan, action, target)
    })
    notify(hooks.progress, { phase: 'verified', task })
    return observation
  }

  /**
   * Records what the script reported. A refusal or an unconfirmed outcome is
   * recorded and then thrown, so cancellation is classified before it
   * propagates. A step with no exit status stays open, which is uncertain.
   */
  private async conclude(action: IncusAction, outcome: StepOutcome): Promise<void> {
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

  private unresolved(): InstallerError {
    return new InstallerError({
      code: 'AWS_INCUS_PREPARATION_UNRESOLVED',
      facts: [['Deployment', this.context.deployment.id], ...incusFacts(this.evidence)],
      retry: this.retry,
    })
  }

  /**
   * An initialization, or the open of a preserved installation, establishes the
   * software baseline and the standalone server identity, so neither exists
   * without its step. A preserved open records what is installed and observed
   * now, which verification already required to match the retained pinned
   * packages and the retained certificate fingerprint. It keeps the retained
   * subordinate-ID ranges unchanged, so extra ranges never ratchet into the
   * record.
   */
  private established(plan: ApprovedPlan, action: IncusAction, observation: Observation): Partial<IncusRecord> {
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

  private async verified(plan: ApprovedPlan, action: IncusAction, target: InspectTarget): Promise<Observation> {
    const observation = await this.inspect(target, plan)
    if (!verify(action, plan, observation)) {
      throw this.unresolved()
    }
    await this.amend({ verifiedAt: new Date().toISOString() }, this.established(plan, action, observation))
    return observation
  }

  /**
   * A step that exited zero but was never verified is accounting work, not
   * replay: only a fresh inspection is needed.
   */
  private async settleReturned(target: InspectTarget): Promise<Observation | null> {
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
    return await this.verified(plan, pending.action, target)
  }
}
