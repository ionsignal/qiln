export const DestroyCapsuleStepKey = {
  PLAN_DESTROY: 'plan_destroy',
  DELETE_BRANCH_INSTANCES: 'delete_branch_instances',
  DELETE_BRANCH_VOLUMES: 'delete_branch_volumes',
  FINALIZE_DERIVED_RESOURCE_OUTCOMES: 'finalize_derived_resource_outcomes',
  VERIFY_TERMINAL_RESOURCE_OUTCOMES: 'verify_terminal_resource_outcomes',
} as const

export type DestroyCapsuleStepKey = (typeof DestroyCapsuleStepKey)[keyof typeof DestroyCapsuleStepKey]

/**
 * Stable accounting boundaries for one destroy execution.
 *
 * These keys identify durable inspection records only. They are not resumable
 * checkpoints and never authorize an abandoned operation to continue.
 */
export const DestroyCapsuleStepKeys = [
  DestroyCapsuleStepKey.PLAN_DESTROY,
  DestroyCapsuleStepKey.DELETE_BRANCH_INSTANCES,
  DestroyCapsuleStepKey.DELETE_BRANCH_VOLUMES,
  DestroyCapsuleStepKey.FINALIZE_DERIVED_RESOURCE_OUTCOMES,
  DestroyCapsuleStepKey.VERIFY_TERMINAL_RESOURCE_OUTCOMES,
] as const satisfies readonly DestroyCapsuleStepKey[]
