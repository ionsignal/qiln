import { randomUUID } from 'node:crypto'
import { RECIPE } from '../../../remote/incus/recipe'
import { InstallerError, type DiagnosticFact } from '../../../diagnostic/error'
import { apply } from '../../../remote/incus/apply'
import { inspectHost } from '../../../remote/incus/inspect'
import { planOf, releasePlanOf } from '../../../remote/incus/plan'
import { preseedOf, type Preseed } from '../../../remote/incus/preseed'
import { verify } from '../../../remote/incus/verify'
import { checkCancellation } from '../../../terminal/prompts'
import { userId } from '../../host'
import { sameJson } from '../../json'
import { notify, withWaiting, type ProgressSink, type ProgressTask } from '../progress'
import { incusFacts, requireNotStuck, retainedPreseed, returned } from './facts'
import {
  actionsOf,
  type ApprovedPlan,
  type IncusTarget,
  type InitializePlan,
  type Observation,
  type Plan,
} from '../../../remote/incus/types'
import * as deployments from '../records'
import * as records from './records'
import type { StepOutcome } from '../../../remote/step'
import type { IncusAction } from '../../../remote/incus/spec'
import type { Remote } from '../../../ssh/connections'
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
 * inspection must agree before `verifiedAt` is persisted. An initialization is
 * also planned again from a fresh inspection after approval, before anything is
 * persisted. Nothing is replayed, resumed, or rolled back, and an interrupted
 * step stays open as evidence. A release that finds every unit already inactive
 * runs nothing: it retains only the observation. It runs parallel to the ZFS
 * preparer and shares only the journal rules.
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

  /**
   * Verifies a step left returned by an earlier run, then plans from fresh
   * evidence. Each approval covers only the plan displayed with it, so the
   * repository, the packages, the initialization, and the socket access grant
   * each ask again. Returns how many steps were applied, and stops once the
   * approved configuration holds.
   */
  public async run(target: IncusTarget, signal: AbortSignal): Promise<number> {
    const { hooks } = this.context
    const preseed = preseedOf(target.pool)
    let observation = (await this.settleReturned(target)) ?? (await this.inspect(target))
    let applied = 0
    while (true) {
      const plan = planOf(observation, target, preseed, retainedPreseed(this.evidence))
      hooks.show(observation, plan)
      switch (plan.kind) {
        case 'refused':
          throw refusal(plan.reasons, this.retry)
        case 'ready':
          return applied
        case 'repository':
        case 'packages':
        case 'access':
        case 'initialize': {
          const recheck = plan.kind === 'initialize' ? () => this.confirmCurrent(plan, target, preseed) : undefined
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
   * Stops Incus before the separate ZFS export. A fresh observation decides:
   * units that are all positively inactive need no stop, and only that
   * observation is retained, as point-in-time evidence and not as an executed
   * step. Otherwise the release runs under its own approval. Incus is not
   * queried afterwards.
   */
  public async release(target: IncusTarget, signal: AbortSignal): Promise<void> {
    const { hooks } = this.context
    const observation = (await this.settleReturned(target)) ?? (await this.inspect(target))
    const plan = releasePlanOf(observation, target)
    hooks.show(observation, plan)
    switch (plan.kind) {
      case 'refused':
        throw refusal(plan.reasons, this.retry)
      case 'stopped':
        await this.persist({ quiescence: { observedAt: observation.observedAt } })
        return
      case 'release': {
        const authorization = await this.authorize(plan)
        await this.step(authorization, plan, 'release', target, signal)
      }
    }
  }

  /**
   * The inspection asks about the approved packages too, so the whole frozen
   * transaction is checked and not only the direct packages.
   */
  private async inspect(target: IncusTarget, plan?: ApprovedPlan): Promise<Observation> {
    const approved = plan?.kind === 'packages' ? plan.install.map(change => change.name) : []
    return await inspectHost(this.context.remote, target, approved)
  }

  /**
   * The operator may take a while to approve, so an initialization is planned
   * again from a fresh inspection, and the approved plan must still be exactly
   * what is planned now. This refuses before anything is persisted, so a new
   * invocation can try again.
   */
  private async confirmCurrent(approved: InitializePlan, target: IncusTarget, preseed: Preseed): Promise<void> {
    const current = planOf(await this.inspect(target), target, preseed, retainedPreseed(this.evidence))
    if (current.kind === 'refused') {
      throw refusal(current.reasons, this.retry)
    }
    if (!sameJson(current, approved)) {
      throw refusal(
        ['The host changed after the plan was displayed, so the approved initialization was not applied.'],
        this.retry,
      )
    }
  }

  private async persist(changes: Partial<IncusRecord>): Promise<void> {
    const next = { ...this.evidence, ...changes }
    await records.save(this.context.root, this.directory, this.context.deployment, next)
    this.evidence = next
  }

  private async amend(change: Partial<IncusStep>): Promise<void> {
    const { steps } = this.evidence
    await this.persist({
      steps: [...steps.slice(0, -1), { ...steps[steps.length - 1], ...change }],
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
    target: IncusTarget,
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

  private async verified(plan: ApprovedPlan, action: IncusAction, target: IncusTarget): Promise<Observation> {
    const observation = await this.inspect(target, plan)
    if (!verify(action, plan, observation)) {
      throw new InstallerError({
        code: 'AWS_INCUS_PREPARATION_UNRESOLVED',
        facts: [['Deployment', this.context.deployment.id], ...incusFacts(this.evidence)],
        retry: this.retry,
      })
    }
    await this.amend({ verifiedAt: new Date().toISOString() })
    return observation
  }

  /**
   * A step that exited zero but was never verified is accounting work, not
   * replay: only a fresh inspection is needed.
   */
  private async settleReturned(target: IncusTarget): Promise<Observation | null> {
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
