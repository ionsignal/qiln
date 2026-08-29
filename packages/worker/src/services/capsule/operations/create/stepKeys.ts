export const CreateCapsuleStepKey = {
  INITIALIZE_SSH_ACCESS_FENCE: 'initialize_ssh_access_fence',
  PLAN_RESOURCES: 'plan_resources',
  RECORD_RESOURCE_INVENTORY: 'record_resource_inventory',
  VERIFY_ROOTFS_IMAGE: 'verify_rootfs_image',
  ENSURE_NAMESPACE: 'ensure_namespace',
  RECORD_BIND_MOUNTS: 'record_bind_mounts',
  CREATE_VOLUMES: 'create_volumes',
  CREATE_INSTANCE: 'create_instance',
  WRITE_PROVISIONING_FILES: 'write_provisioning_files',
  COMPLETE_CREATE: 'complete_create',
} as const

export type CreateCapsuleStepKey = (typeof CreateCapsuleStepKey)[keyof typeof CreateCapsuleStepKey]

/**
 * These keys identify durable accounting records only. They are not resumable
 * checkpoints and never authorize an abandoned create operation to continue.
 */
export const CreateCapsuleStepKeys = [
  CreateCapsuleStepKey.INITIALIZE_SSH_ACCESS_FENCE,
  CreateCapsuleStepKey.PLAN_RESOURCES,
  CreateCapsuleStepKey.RECORD_RESOURCE_INVENTORY,
  CreateCapsuleStepKey.VERIFY_ROOTFS_IMAGE,
  CreateCapsuleStepKey.ENSURE_NAMESPACE,
  CreateCapsuleStepKey.RECORD_BIND_MOUNTS,
  CreateCapsuleStepKey.CREATE_VOLUMES,
  CreateCapsuleStepKey.CREATE_INSTANCE,
  CreateCapsuleStepKey.WRITE_PROVISIONING_FILES,
  CreateCapsuleStepKey.COMPLETE_CREATE,
] as const satisfies readonly CreateCapsuleStepKey[]
