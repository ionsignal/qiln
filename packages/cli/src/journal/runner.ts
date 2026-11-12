import { randomUUID } from 'node:crypto'
import { checkCancellation } from '../terminal/prompts'
import { currentUserId } from '../state/user'
import { returned, type JournalStep } from './step'
import { stepFailure, type StepOutcome } from '../host/step'
import { InstallerError, type InstallerErrorCode } from '../diagnostic/error'
import type { JournalAuthorization } from './history'

export interface Evidence<Plan, Action extends string> {
  authorizations: readonly JournalAuthorization<Plan>[]
  steps: readonly (JournalStep & { action: Action })[]
}

/**
 * `run` receives the record as it stands after the fence, so an owner derives
 * execution authority from durable evidence and not from a retained request.
 */
export interface StepJournalOptions<Rec, Plan, Action extends string> {
  record: Rec
  save(next: Rec): Promise<void>
  recipe: { revision: number; digest: string }
  failureCode: InstallerErrorCode
  retry: string
  run(plan: Plan, action: Action, record: Rec): Promise<StepOutcome>
  approve(plan: Plan): Promise<void>
  progress?(phase: 'working' | 'verified', action: Action): void
}

export interface AuthorizeOptions {
  recheck?: (() => Promise<void>) | undefined
  approvedAt?: string | undefined
}

type StepProgress = Partial<Pick<JournalStep, 'completion' | 'refusedAt' | 'verifiedAt'>>

/**
 * The one fenced-step skeleton shared by every journaled workflow: persist the
 * authorization, fence the step, run the remote call, record its outcome, then
 * let the owner verify against a fresh observation. Owners supply the domain
 * `verify`, so nothing here knows what a pool or a daemon is.
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

  /**
   * Presentation cannot decide whether a step completed or verified.
   */
  private report(phase: 'working' | 'verified', action: Action): void {
    try {
      this.options.progress?.(phase, action)
    } catch {
      // Intentionally ignored.
    }
  }

  public async amend(change: StepProgress, extras: Partial<Rec> = {}): Promise<void> {
    const { steps } = this.current
    await this.commit({
      ...this.current,
      steps: [...steps.slice(0, -1), { ...steps[steps.length - 1], ...change }],
      ...extras,
    })
  }

  /**
   * Every plan is persisted as its own authorization, even when one approval
   * covered several.
   */
  public async authorize(plan: Plan, { recheck, approvedAt }: AuthorizeOptions = {}): Promise<string> {
    if (approvedAt === undefined) {
      await this.options.approve(plan)
    }
    await recheck?.()
    const { revision, digest } = this.options.recipe
    const id = randomUUID()
    await this.commit({
      ...this.current,
      authorizations: [
        ...this.current.authorizations,
        {
          id,
          approvedAt: approvedAt ?? new Date().toISOString(),
          approvedBy: { method: 'local-interactive', userId: currentUserId() },
          recipe: { revision, digest },
          plan,
        },
      ],
    })
    return id
  }

  public async step<Observed>(
    authorization: string,
    plan: Plan,
    action: Action,
    signal: AbortSignal,
    verify: () => Promise<Observed>,
  ): Promise<Observed> {
    checkCancellation(signal)
    this.report('working', action)
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
    await this.conclude(action, await this.options.run(plan, action, this.current))
    const observed = await verify()
    this.report('verified', action)
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
        throw stepFailure(failureCode, retry, action, outcome)
      case 'uncertain':
        if (outcome.exitCode !== null) {
          await this.amend({ completion: { exitCode: outcome.exitCode, completedAt: at } })
        }
        throw stepFailure(failureCode, retry, action, outcome)
    }
  }
}
