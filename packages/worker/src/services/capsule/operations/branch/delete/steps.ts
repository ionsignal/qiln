export const CapsuleBranchDeleteStepKey = {
  PLAN_DELETE: 'plan_delete',
  DELETE_INSTANCE: 'delete_instance',
  DELETE_VOLUMES: 'delete_volumes',
  DELETE_DISCOVERED_RESOURCES: 'delete_discovered_resources',
  MARK_PROVISIONING_FILES_DELETED: 'mark_provisioning_files_deleted',
  DELETE_BRANCH_RECORD: 'delete_branch_record',
} as const

export type CapsuleBranchDeleteStepKey = (typeof CapsuleBranchDeleteStepKey)[keyof typeof CapsuleBranchDeleteStepKey]

/**
 * Stable delete step order for visibility and fail-closed diagnostics.
 *
 * These are inspection/accounting boundaries only. They do not imply resumable
 * recovery for interrupted branch delete operations.
 */
export const CapsuleBranchDeleteStepKeys = [
  CapsuleBranchDeleteStepKey.PLAN_DELETE,
  CapsuleBranchDeleteStepKey.DELETE_INSTANCE,
  CapsuleBranchDeleteStepKey.DELETE_VOLUMES,
  CapsuleBranchDeleteStepKey.DELETE_DISCOVERED_RESOURCES,
  CapsuleBranchDeleteStepKey.MARK_PROVISIONING_FILES_DELETED,
  CapsuleBranchDeleteStepKey.DELETE_BRANCH_RECORD,
] as const satisfies readonly CapsuleBranchDeleteStepKey[]
