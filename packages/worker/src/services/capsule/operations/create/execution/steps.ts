import { CapsuleCreatePhase } from './phases'

export const CapsuleCreateStepKey = {
  INITIALIZE_SSH_ACCESS_FENCE: CapsuleCreatePhase.INITIALIZE_SSH_ACCESS_FENCE,
  PLAN_RESOURCES: CapsuleCreatePhase.PLAN_RESOURCES,
  MATERIALIZE_RESOURCES: CapsuleCreatePhase.RECORD_MATERIALIZE_RESOURCES,
  VERIFY_ROOTFS_IMAGE: CapsuleCreatePhase.VERIFY_ROOTFS_IMAGE,
  ENSURE_NAMESPACE: CapsuleCreatePhase.ENSURE_NAMESPACE,
  RECORD_BIND_MOUNTS: CapsuleCreatePhase.RECORD_BIND_MOUNTS,
  CREATE_VOLUMES: CapsuleCreatePhase.CREATE_VOLUMES,
  CREATE_INSTANCE: CapsuleCreatePhase.CREATE_INSTANCE,
  WRITE_PROVISIONING_FILES: CapsuleCreatePhase.WRITE_PROVISIONING_FILES,
  COMPLETE_CREATE: CapsuleCreatePhase.COMPLETE_CREATE,
} as const

export type CapsuleCreateStepKey = (typeof CapsuleCreateStepKey)[keyof typeof CapsuleCreateStepKey]

/**
 * These keys identify durable accounting records only. They are not resumable
 * checkpoints and never authorize an abandoned create operation to continue.
 */
export const CapsuleCreateStepKeys = [
  CapsuleCreateStepKey.INITIALIZE_SSH_ACCESS_FENCE,
  CapsuleCreateStepKey.PLAN_RESOURCES,
  CapsuleCreateStepKey.MATERIALIZE_RESOURCES,
  CapsuleCreateStepKey.VERIFY_ROOTFS_IMAGE,
  CapsuleCreateStepKey.ENSURE_NAMESPACE,
  CapsuleCreateStepKey.RECORD_BIND_MOUNTS,
  CapsuleCreateStepKey.CREATE_VOLUMES,
  CapsuleCreateStepKey.CREATE_INSTANCE,
  CapsuleCreateStepKey.WRITE_PROVISIONING_FILES,
  CapsuleCreateStepKey.COMPLETE_CREATE,
] as const satisfies readonly CapsuleCreateStepKey[]
