import { randomUUID } from 'node:crypto'
import { InstallerError, type InstallerErrorCode } from '../../../diagnostic/error'
import { checkCancellation } from '../../../terminal/prompts'
import { returned, type JournalStep } from '../../../journal/step'
import type { JournalAuthorization } from '../../../journal/history'
import type { StepOutcome } from '../../../host/step'
import { notify, withWaiting, type ProgressSink, type ProgressTask } from '../progress'
import { userId } from '../../host'

export interface Evidence<Plan, Action extends string> {
  authorizations: readonly JournalAuthorization<Plan>[]
  steps: readonly (JournalStep & { action: Action })[]
}

export interface StepJournalOptions<Rec, Plan, Action extends string> {
  record: Rec
  save(next: Rec): Promise<void>
  recipe: { revision: number; digest: string }
  failureCode: InstallerErrorCode
  retry: string
  task(action: Action): ProgressTask
  run(plan: Plan, action: Action): Promise<StepOutcome>
  approve(plan: Plan): Promise<void>
  progress: ProgressSink | undefined
}

type StepProgress = Partial<Pick<JournalStep, 'completion' | 'refusedAt' | 'verifiedAt'>>

interface Authorization<Plan> extends JournalAuthorization<Plan> {
  approvedBy: { method: 'local-interactive'; userId: number }
  recipe: { revision: number; digest: string }
}

function failure(
  code: InstallerErrorCode,
  retry: string,
  action: string,
  outcome: Exclude<StepOutcome, { kind: 'returned' }>,
): InstallerError {
  if (outcome.cause?.kind === 'cancelled') {
    return outcome.cause
  }
  return new InstallerError({
    code,
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
 * The one fenced-step skeleton shared by the ZFS and Incus preparers: persist
 * the authorization, fence the step, run the remote call, record its outcome,
 * then let the owner verify against a fresh observation. Owners supply the
 * domain `verify`, so nothing here knows what a pool or a daemon is.
 */
export class StepJournal<Rec extends Evidence<Plan, Action>, Plan, Action extends string> {
  private current: Rec

  constructor(private readonly options: StepJournalOptions<Rec, Plan, Action>) {
    this.current = options.record
  }

  public get record(): Rec {
    return this.current
  }

  /**
   * The in-memory record only advances after the write succeeded.
   */
  private async commit(next: Rec): Promise<void> {
    await this.options.save(next)
    this.current = next
  }

  public async amend(change: StepProgress, extras: Partial<Rec> = {}): Promise<void> {
    const { steps } = this.current
    await this.commit({
      ...this.current,
      steps: [...steps.slice(0, -1), { ...steps[steps.length - 1], ...change }],
      ...extras,
    })
  }

  public async authorize(plan: Plan, recheck?: () => Promise<void>): Promise<string> {
    await this.options.approve(plan)
    await recheck?.()
    const { revision, digest } = this.options.recipe
    const authorization: Authorization<Plan> = {
      id: randomUUID(),
      approvedAt: new Date().toISOString(),
      approvedBy: { method: 'local-interactive', userId: userId() },
      recipe: { revision, digest },
      plan,
    }
    await this.commit({ ...this.current, authorizations: [...this.current.authorizations, authorization] })
    return authorization.id
  }

  public async step<Observed>(
    authorization: string,
    plan: Plan,
    action: Action,
    signal: AbortSignal,
    verify: () => Promise<Observed>,
  ): Promise<Observed> {
    const { progress } = this.options
    checkCancellation(signal)
    const task = this.options.task(action)
    notify(progress, { phase: 'working', task })
    await this.commit({
      ...this.current,
      steps: [
        ...this.current.steps,
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
    const observed = await withWaiting(progress, task, async () => {
      await this.conclude(action, await this.options.run(plan, action))
      return await verify()
    })
    notify(progress, { phase: 'verified', task })
    return observed
  }

  /**
   * A step that exited zero but was never verified is accounting work, not
   * replay: the owner only needs a fresh inspection.
   */
  public async settle<Observed>(verify: (plan: Plan, action: Action) => Promise<Observed>): Promise<Observed | null> {
    const pending = returned(this.current.steps).at(-1)
    if (pending === undefined) {
      return null
    }
    const plan = this.current.authorizations.find(({ id }) => id === pending.authorization)?.plan
    if (plan === undefined) {
      throw new InstallerError({
        code: 'INTERNAL_ERROR',
        retry: this.options.retry,
      })
    }
    return await verify(plan, pending.action)
  }

  /**
   * Records what the script reported. A refusal or an unconfirmed outcome is
   * recorded and then thrown, so cancellation is classified before it
   * propagates. A step with no exit status stays open, which is uncertain.
   */
  private async conclude(action: Action, outcome: StepOutcome): Promise<void> {
    const { failureCode, retry } = this.options
    const at = new Date().toISOString()
    switch (outcome.kind) {
      case 'returned':
        await this.amend({ completion: { exitCode: 0, completedAt: at } })
        return
      case 'refused':
        await this.amend({ refusedAt: at })
        throw failure(failureCode, retry, action, outcome)
      case 'uncertain':
        if (outcome.exitCode !== null) {
          await this.amend({ completion: { exitCode: outcome.exitCode, completedAt: at } })
        }
        throw failure(failureCode, retry, action, outcome)
    }
  }
}
