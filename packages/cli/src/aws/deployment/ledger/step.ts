import type { Step } from '../types'

/**
 * Derived from the ledger fields and never persisted. The step schema already forbids
 * a response and a failure on the same step, so that is not rechecked here.
 *
 * - open: fenced with no outcome recorded. Only an open step may have a child
 *   run against it; a lost parent can also leave one behind.
 * - uncertain: a child ran and the effect is unknown.
 * - refused: the provider definitely refused, or the call was never dispatched.
 *   `failure.outcome` says how.
 * - returned: the response is retained but not yet observed.
 * - verified: a polled observation agreed with the ledger.
 *
 * Child termination is independent of every state.
 */
export type StepState = 'open' | 'uncertain' | 'refused' | 'returned' | 'verified'

export function stateOf(step: Step): StepState {
  if (step.failure !== null) {
    return step.failure.outcome === 'uncertain' ? 'uncertain' : 'refused'
  }
  if (step.verifiedAt !== null) {
    return 'verified'
  }
  return step.returned === null ? 'open' : 'returned'
}

/**
 * A launch attempt that AWS definitely refused for lack of capacity, with child
 * termination confirmed. It launched nothing, and it is the only failure after
 * which the next approved zone may be tried.
 */
export function declined(step: Step): boolean {
  return (
    step.action === 'run-instances' &&
    step.failure?.outcome === 'rejected' &&
    step.failure.code === 'AWS_DEPLOYMENT_CAPACITY' &&
    step.failure.termination === 'confirmed'
  )
}

/**
 * Nothing about a settled step blocks planning removal. A creation's retained
 * identity is enough to clean up, but a deletion stays unsettled until an
 * observation verifies it.
 */
export function settled(step: Step): boolean {
  switch (stateOf(step)) {
    case 'refused':
    case 'verified':
      return true
    case 'returned':
      return step.removal === null
    case 'open':
    case 'uncertain':
      return false
  }
}

/**
 * Removal steps the provider definitely refused. Each one spends the removal
 * budget, while verified deletions never do, so progress is bounded by the
 * resource count alone. A step that was never dispatched, because it was
 * refused or cancelled locally, did not involve the provider and is not counted.
 */
export function refusals(steps: readonly Step[]): number {
  return steps.filter(
    step => step.removal !== null && stateOf(step) === 'refused' && step.failure?.outcome !== 'unattempted',
  ).length
}
