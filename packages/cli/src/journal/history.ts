import { z } from 'zod'
import { sameJson } from '../json'
import { operationId, progressed, settled, stateOf, timestamp, type JournalStep } from './step'

/**
 * One approved plan. The approver is the trusted local invocation identity, not
 * the AWS operator, because a retained SSH pin involves no fresh AWS
 * authentication. The recipe identifies the exact scripts that were approved.
 * Each journal supplies the schema of its own plans.
 */
export function authorizationSchemaOf<Plan extends z.ZodType>(plan: Plan) {
  return z.strictObject({
    id: operationId,
    approvedAt: timestamp,
    approvedBy: z.strictObject({
      method: z.literal('local-interactive'),
      userId: z.int().nonnegative(),
    }),
    recipe: z.strictObject({
      revision: z.int().positive(),
      digest: z.string().regex(/^[0-9a-f]{64}$/),
    }),
    plan,
  })
}

/**
 * The fields of an authorization that the shared rules read.
 */
export interface JournalAuthorization<Plan> {
  id: string
  approvedAt: string
  plan: Plan
}

export interface History<Plan> {
  authorizations: readonly JournalAuthorization<Plan>[]
  steps: readonly JournalStep[]
}

/**
 * Whether every step follows an existing authorization that allows its action,
 * only the last step may be unsettled, and identities and chronology hold.
 */
export function isHistoryConsistent<Plan>(
  history: History<Plan>,
  actionsOf: (plan: Plan) => readonly string[],
): boolean {
  const { authorizations, steps } = history
  return (
    new Set(authorizations.map(authorization => authorization.id)).size === authorizations.length &&
    new Set(steps.map(step => step.id)).size === steps.length &&
    steps.slice(0, -1).every(settled) &&
    steps.every((step, index) => {
      const authorization = authorizations.find(({ id }) => id === step.authorization)
      return (
        authorization !== undefined &&
        actionsOf(authorization.plan).includes(step.action) &&
        step.fencedAt >= authorization.approvedAt &&
        (index === 0 || steps[index - 1].fencedAt <= step.fencedAt)
      )
    })
  )
}

function unchanged(before: readonly unknown[], after: readonly unknown[]): boolean {
  return before.length <= after.length && before.every((item, index) => sameJson(item, after[index]))
}

/**
 * The journal's write rule: history is append-only, one write adds at most one
 * authorization or one fenced step but never both, a new authorization needs
 * every step settled, a new step starts open, and otherwise only the last step
 * may progress. Both histories are already validated and consistent.
 */
export function isAppendOnly<Plan>(before: History<Plan>, after: History<Plan>): boolean {
  const authorized = after.authorizations.length - before.authorizations.length
  const fenced = after.steps.length - before.steps.length
  if (
    authorized < 0 ||
    authorized > 1 ||
    fenced < 0 ||
    fenced > 1 ||
    (authorized === 1 && fenced === 1) ||
    !unchanged(before.authorizations, after.authorizations)
  ) {
    return false
  }
  if (authorized === 1 && !after.steps.every(settled)) {
    return false
  }
  if (fenced === 1) {
    return unchanged(before.steps, after.steps) && stateOf(after.steps[after.steps.length - 1]) === 'open'
  }
  if (before.steps.length === 0) {
    return true
  }
  return (
    unchanged(before.steps.slice(0, -1), after.steps) &&
    progressed(before.steps[before.steps.length - 1], after.steps[after.steps.length - 1])
  )
}
