import { CreatePhase } from './phases'

export const CreateCapsuleStepKey = {
  INITIALIZE_SSH_ACCESS_FENCE: CreatePhase.INITIALIZE_SSH_ACCESS_FENCE,
  PLAN_RESOURCES: CreatePhase.PLAN_RESOURCES,
  RECORD_RESOURCE_INVENTORY: CreatePhase.RECORD_RESOURCE_INVENTORY,
  VERIFY_ROOTFS_IMAGE: CreatePhase.VERIFY_ROOTFS_IMAGE,
  ENSURE_NAMESPACE: CreatePhase.ENSURE_NAMESPACE,
  RECORD_BIND_MOUNTS: CreatePhase.RECORD_BIND_MOUNTS,
  CREATE_VOLUMES: CreatePhase.CREATE_VOLUMES,
  CREATE_INSTANCE: CreatePhase.CREATE_INSTANCE,
  WRITE_PROVISIONING_FILES: CreatePhase.WRITE_PROVISIONING_FILES,
  COMPLETE_CREATE: CreatePhase.COMPLETE_CREATE,
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
