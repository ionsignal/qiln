/**
 * Worker capsule mutation policy.
 *
 * The MVP worker executes capsule branch mutations inline. Durable operation,
 * step, and resource rows are a fail-closed mutation ledger: they provide
 * idempotency, failure inspection, and cleanup accounting. They are not a
 * background queue, lease system, or automatic provisioning recovery engine.
 *
 * If the worker crashes or stops while provisioning a branch, Qiln treats that
 * operation as uncertain on the next boot and marks it cleanup_required. The user
 * should create a new branch from a known-good capsule snapshot once cleanup has
 * been reviewed. Product-level rollback remains route alias rollback to an
 * approved capsule version/snapshot, not magical reversal of external effects.
 */
export const CapsuleOperationExecutionPolicy = {
  INLINE_FAIL_CLOSED_LEDGER: 'inline_fail_closed_ledger',
} as const

export type CapsuleOperationExecutionPolicy = (typeof CapsuleOperationExecutionPolicy)[keyof typeof CapsuleOperationExecutionPolicy]
