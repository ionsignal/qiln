export const BootstrapStepKey = {
  PLAN_RESOURCES: 'plan_resources',
  RECORD_RESOURCE_INVENTORY: 'record_resource_inventory',
  ENSURE_NAMESPACE: 'ensure_namespace',
  RECORD_BIND_MOUNTS: 'record_bind_mounts',
  CREATE_VOLUMES: 'create_volumes',
  CREATE_INSTANCE: 'create_instance',
  WRITE_PROVISIONING_FILES: 'write_provisioning_files',
  FINALIZE_BRANCH_OFFLINE: 'finalize_branch_offline',
} as const

export type BootstrapStepKey = (typeof BootstrapStepKey)[keyof typeof BootstrapStepKey]

/**
 * Stable root-bootstrap step order for durable visibility and fail-closed
 * diagnostics.
 *
 * These values identify database accounting records. They are not resumable
 * phase checkpoints, queue jobs, leases, retries, or operation-runner stages.
 */
export const BootstrapStepKeys = [
  BootstrapStepKey.PLAN_RESOURCES,
  BootstrapStepKey.RECORD_RESOURCE_INVENTORY,
  BootstrapStepKey.ENSURE_NAMESPACE,
  BootstrapStepKey.RECORD_BIND_MOUNTS,
  BootstrapStepKey.CREATE_VOLUMES,
  BootstrapStepKey.CREATE_INSTANCE,
  BootstrapStepKey.WRITE_PROVISIONING_FILES,
  BootstrapStepKey.FINALIZE_BRANCH_OFFLINE,
] as const satisfies readonly BootstrapStepKey[]
