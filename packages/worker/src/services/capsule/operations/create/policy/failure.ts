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
  inventory: 'absent' | 'untouched' | 'changed' | 'inconsistent'
  compensationProven: boolean
}

/**
 * Selects a disposition from facts assembled by the locked classification
 * transaction.
 *
 * No provider intent is safe only with valid lineage and either no inventory
 * evidence or a complete untouched plan. Compensation requires a complete
 * validated ledger and positive same-process cleanup evidence.
 */
export function classifyCreateCapsuleFailure(facts: CreateCapsuleFailureFacts): CreateCapsuleFailureDisposition {
  if (!facts.consistent || facts.providerOwnershipUncertain || facts.completionAttempted) {
    return CreateCapsuleFailureDisposition.CLEANUP_REQUIRED
  }
  if (!facts.providerIntentRecorded) {
    return facts.inventory === 'absent' || facts.inventory === 'untouched'
      ? CreateCapsuleFailureDisposition.PRE_PROVIDER
      : CreateCapsuleFailureDisposition.CLEANUP_REQUIRED
  }
  if (
    (facts.inventory === 'untouched' || facts.inventory === 'changed') &&
    facts.compensationProven
  ) {
    return CreateCapsuleFailureDisposition.COMPENSATED
  }
  return CreateCapsuleFailureDisposition.CLEANUP_REQUIRED
}
