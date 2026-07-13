export const CapsuleDestroyStepKey = {
  PLAN_DESTROY: 'plan_destroy',
  DELETE_BRANCH_INSTANCES: 'delete_branch_instances',
  DELETE_BRANCH_VOLUMES: 'delete_branch_volumes',
  FINALIZE_DERIVED_RESOURCE_OUTCOMES: 'finalize_derived_resource_outcomes',
  VERIFY_TERMINAL_RESOURCE_OUTCOMES: 'verify_terminal_resource_outcomes',
} as const

export type CapsuleDestroyStepKey = (typeof CapsuleDestroyStepKey)[keyof typeof CapsuleDestroyStepKey]

/**
 * Stable capsule-destroy accounting order.
 *
 * These keys identify durable inline step records. They are not queue jobs,
 * resumable checkpoints, retries, leases, or scheduler stages.
 */
export const CapsuleDestroyStepKeys = [
  CapsuleDestroyStepKey.PLAN_DESTROY,
  CapsuleDestroyStepKey.DELETE_BRANCH_INSTANCES,
  CapsuleDestroyStepKey.DELETE_BRANCH_VOLUMES,
  CapsuleDestroyStepKey.FINALIZE_DERIVED_RESOURCE_OUTCOMES,
  CapsuleDestroyStepKey.VERIFY_TERMINAL_RESOURCE_OUTCOMES,
] as const satisfies readonly CapsuleDestroyStepKey[]
