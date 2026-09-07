export const CreateCapsuleFailureDisposition = {
  PRE_PROVIDER: 'pre_provider',
  COMPENSATED: 'compensated',
  CLEANUP_REQUIRED: 'cleanup_required',
} as const

export type CreateCapsuleFailureDisposition =
  (typeof CreateCapsuleFailureDisposition)[keyof typeof CreateCapsuleFailureDisposition]

export interface CreateCapsuleFailureFacts {
  consistent: boolean
  providerIntentRecorded: boolean
  providerOwnershipUncertain: boolean
  completionAttempted: boolean
  resourceCount: number
  compensationProven: boolean
}

/**
 * Selects a disposition from facts assembled by the locked classification
 * transaction.
 *
 * Compensation is proven only when same-process cleanup succeeded and the
 * durable partial resource ledger contains no remaining or uncertain deletion
 * obligations. Completion uncertainty always prevents ordinary failure.
 */
export function classifyCreateCapsuleFailure(facts: CreateCapsuleFailureFacts): CreateCapsuleFailureDisposition {
  if (!facts.consistent || facts.providerOwnershipUncertain || facts.completionAttempted) {
    return CreateCapsuleFailureDisposition.CLEANUP_REQUIRED
  }
  if (!facts.providerIntentRecorded) {
    return facts.resourceCount === 0
      ? CreateCapsuleFailureDisposition.PRE_PROVIDER
      : CreateCapsuleFailureDisposition.CLEANUP_REQUIRED
  }
  return facts.compensationProven
    ? CreateCapsuleFailureDisposition.COMPENSATED
    : CreateCapsuleFailureDisposition.CLEANUP_REQUIRED
}
