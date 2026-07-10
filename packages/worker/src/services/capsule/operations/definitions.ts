/**
 * Worker capsule mutation policy.
 */
export const CapsuleOperationExecutionPolicy = {
  INLINE_FAIL_CLOSED_LEDGER: 'inline_fail_closed_ledger',
} as const

export type CapsuleOperationExecutionPolicy = (typeof CapsuleOperationExecutionPolicy)[keyof typeof CapsuleOperationExecutionPolicy]
