import { z } from 'zod'
import { isOperationId, isTimestamp } from '../guards'
import { sameJson } from '../json'

export const operationId = z.string().refine(isOperationId, 'Expected an operation ID.')
export const timestamp = z.string().refine(isTimestamp, 'Expected a canonical timestamp.')

/**
 * One fenced remote effect. A refusal is a definite absence of effect, so it
 * never coexists with a completion. A completion with a nonzero exit code does
 * not establish that nothing changed, and a zero exit code is not verified
 * until `verifiedAt` is set. Timestamps never precede the event they follow.
 * Each journal supplies the schema of its own actions.
 */
export function stepSchemaOf<Action extends z.ZodType<string>>(action: Action) {
  return z
    .strictObject({
      id: operationId,
      authorization: operationId,
      action,
      fencedAt: timestamp,
      completion: z
        .strictObject({
          exitCode: z.int().min(0).max(255),
          completedAt: timestamp,
        })
        .nullable(),
      refusedAt: timestamp.nullable(),
      verifiedAt: timestamp.nullable(),
    })
    .refine(
      ({ completion, refusedAt }) => refusedAt === null || completion === null,
      'Expected a refusal or a completion, not both.',
    )
    .refine(
      ({ completion, verifiedAt }) => verifiedAt === null || completion?.exitCode === 0,
      'Expected verification only after a zero exit.',
    )
    .refine(
      ({ fencedAt, completion, refusedAt, verifiedAt }) =>
        (completion === null || completion.completedAt >= fencedAt) &&
        (refusedAt === null || refusedAt >= fencedAt) &&
        (verifiedAt === null || (completion !== null && verifiedAt >= completion.completedAt)),
      'Expected chronological step timestamps.',
    )
}

/**
 * The fields of a fenced step that every journal shares.
 */
export interface JournalStep {
  id: string
  authorization: string
  action: string
  fencedAt: string
  completion: { exitCode: number; completedAt: string } | null
  refusedAt: string | null
  verifiedAt: string | null
}

/**
 * Derived from the step fields and never persisted.
 *
 * - open: fenced with no outcome recorded.
 * - uncertain: completed with a nonzero exit, which does not show that nothing changed.
 * - returned: exited zero, but the postcondition was not verified.
 * - refused: definitely refused before any effect.
 * - verified: a fresh observation agreed.
 */
export type StepState = 'open' | 'uncertain' | 'returned' | 'refused' | 'verified'

export function stateOf(step: JournalStep): StepState {
  if (step.refusedAt !== null) {
    return 'refused'
  }
  if (step.completion === null) {
    return 'open'
  }
  if (step.completion.exitCode !== 0) {
    return 'uncertain'
  }
  return step.verifiedAt === null ? 'returned' : 'verified'
}

/**
 * A settled step has a definite outcome, so a later step may follow it.
 */
export function settled(step: JournalStep): boolean {
  const state = stateOf(step)
  return state === 'refused' || state === 'verified'
}

/**
 * Steps whose effect is unknown and which only an operator can resolve: open
 * or uncertain. Nothing clears them, and they are never replayed or resumed.
 */
export function stuck<T extends JournalStep>(steps: readonly T[]): T[] {
  return steps.filter(step => {
    const state = stateOf(step)
    return state === 'open' || state === 'uncertain'
  })
}

/**
 * Steps that exited zero but were not verified yet. A fresh inspection can
 * verify them, which is accounting and not replay.
 */
export function returned<T extends JournalStep>(steps: readonly T[]): T[] {
  return steps.filter(step => stateOf(step) === 'returned')
}

/**
 * Stuck plus returned steps.
 */
export function unsettled<T extends JournalStep>(steps: readonly T[]): T[] {
  return steps.filter(step => !settled(step))
}

/**
 * Evidence is set once: a step keeps its identity, and its completion,
 * refusal, and verification are never rewritten or dropped.
 */
export function progressed(before: JournalStep, after: JournalStep): boolean {
  return (
    before.id === after.id &&
    before.authorization === after.authorization &&
    before.action === after.action &&
    before.fencedAt === after.fencedAt &&
    (before.completion === null || sameJson(before.completion, after.completion)) &&
    (before.refusedAt === null || before.refusedAt === after.refusedAt) &&
    (before.verifiedAt === null || before.verifiedAt === after.verifiedAt)
  )
}
