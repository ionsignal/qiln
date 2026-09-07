/**
 * Execution phases include durable accounting steps and work that has no step
 * row. Existing values remain unchanged because they also identify historical
 * diagnostics and accounting records.
 */
export const CreatePhase = {
  LOAD_EXECUTION_INPUT: 'load_execution_input',
  CLAIM_OPERATION: 'claim_operation',
  INITIALIZE_SSH_ACCESS_FENCE: 'initialize_ssh_access_fence',
  PLAN_RESOURCES: 'plan_resources',
  RECORD_RESOURCE_INVENTORY: 'record_resource_inventory',
  VERIFY_ROOTFS_IMAGE: 'verify_rootfs_image',
  COMMIT_PROVIDER_INTENT_FENCE: 'commit_provider_intent_fence',
  ENSURE_NAMESPACE: 'ensure_namespace',
  RECORD_BIND_MOUNTS: 'record_bind_mounts',
  CREATE_VOLUMES: 'create_volumes',
  CREATE_INSTANCE: 'create_instance',
  WRITE_PROVISIONING_FILES: 'write_provisioning_files',
  COMPLETE_CREATE: 'complete_create',
  COMPENSATION: 'compensation',
  FAIL_BEFORE_PROVIDER_MUTATION: 'fail_before_provider_mutation',
  FAIL_AFTER_SUCCESSFUL_COMPENSATION: 'fail_after_successful_compensation',
  MARK_CLEANUP_REQUIRED: 'mark_cleanup_required',
  CLASSIFY_ABANDONED: 'startup_abandoned_operation_classification',
} as const

export type CreatePhase = (typeof CreatePhase)[keyof typeof CreatePhase]
