export const CapsuleBranchCreateStepKey = {
  PLAN_RESOURCES: 'plan_resources',
  RECORD_RESOURCE_INVENTORY: 'record_resource_inventory',
  ENSURE_NAMESPACE: 'ensure_namespace',
  RECORD_BIND_MOUNTS: 'record_bind_mounts',
  CREATE_VOLUMES: 'create_volumes',
  CREATE_INSTANCE: 'create_instance',
  WRITE_PROVISIONING_FILES: 'write_provisioning_files',
  FINALIZE_BRANCH_OFFLINE: 'finalize_branch_offline',
} as const

export type CapsuleBranchCreateStepKey = (typeof CapsuleBranchCreateStepKey)[keyof typeof CapsuleBranchCreateStepKey]

/**
 * Stable branch-create step order for visibility and fail-closed diagnostics.
 *
 * These keys intentionally remain worker-internal for now; the public capsule
 * protocol only needs operation receipts until operation inspection is exposed.
 */
export const CapsuleBranchCreateStepKeys = [
  CapsuleBranchCreateStepKey.PLAN_RESOURCES,
  CapsuleBranchCreateStepKey.RECORD_RESOURCE_INVENTORY,
  CapsuleBranchCreateStepKey.ENSURE_NAMESPACE,
  CapsuleBranchCreateStepKey.RECORD_BIND_MOUNTS,
  CapsuleBranchCreateStepKey.CREATE_VOLUMES,
  CapsuleBranchCreateStepKey.CREATE_INSTANCE,
  CapsuleBranchCreateStepKey.WRITE_PROVISIONING_FILES,
  CapsuleBranchCreateStepKey.FINALIZE_BRANCH_OFFLINE,
] as const satisfies readonly CapsuleBranchCreateStepKey[]
