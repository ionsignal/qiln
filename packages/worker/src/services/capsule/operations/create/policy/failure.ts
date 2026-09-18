export const CapsuleCreateFailureDisposition = {
  PRE_PROVIDER: 'pre_provider',
  COMPENSATED: 'compensated',
  CLEANUP_REQUIRED: 'cleanup_required',
} as const

export type CapsuleCreateFailureDisposition =
  (typeof CapsuleCreateFailureDisposition)[keyof typeof CapsuleCreateFailureDisposition]

export interface CapsuleCreateFailureFacts {
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
export function classifyCapsuleCreateFailure(facts: CapsuleCreateFailureFacts): CapsuleCreateFailureDisposition {
  if (!facts.consistent || facts.providerOwnershipUncertain || facts.completionAttempted) {
    return CapsuleCreateFailureDisposition.CLEANUP_REQUIRED
  }
  if (!facts.providerIntentRecorded) {
    return facts.inventory === 'absent' || facts.inventory === 'untouched'
      ? CapsuleCreateFailureDisposition.PRE_PROVIDER
      : CapsuleCreateFailureDisposition.CLEANUP_REQUIRED
  }
  if ((facts.inventory === 'untouched' || facts.inventory === 'changed') && facts.compensationProven) {
    return CapsuleCreateFailureDisposition.COMPENSATED
  }
  return CapsuleCreateFailureDisposition.CLEANUP_REQUIRED
}
