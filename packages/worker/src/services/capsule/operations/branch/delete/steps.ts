export const CapsuleBranchDeleteStepKey = {
  PLAN_DELETE: 'plan_delete',
  DELETE_INSTANCE: 'delete_instance',
  DELETE_VOLUMES: 'delete_volumes',
  FINALIZE_DERIVED_RESOURCE_OUTCOMES: 'finalize_derived_resource_outcomes',
  ARCHIVE_BRANCH_RUNTIME: 'archive_branch_runtime',
} as const

export type CapsuleBranchDeleteStepKey = (typeof CapsuleBranchDeleteStepKey)[keyof typeof CapsuleBranchDeleteStepKey]

/**
 * Stable delete step order for visibility and fail-closed diagnostics.
 *
 * These are inspection and accounting boundaries only. They never authorize live Incus discovery,
 * ownership reconstruction, or automatic resume of an interrupted destructive operation.
 */
export const CapsuleBranchDeleteStepKeys = [
  CapsuleBranchDeleteStepKey.PLAN_DELETE,
  CapsuleBranchDeleteStepKey.DELETE_INSTANCE,
  CapsuleBranchDeleteStepKey.DELETE_VOLUMES,
  CapsuleBranchDeleteStepKey.FINALIZE_DERIVED_RESOURCE_OUTCOMES,
  CapsuleBranchDeleteStepKey.ARCHIVE_BRANCH_RUNTIME,
] as const satisfies readonly CapsuleBranchDeleteStepKey[]
