import { z } from 'zod'
import { CapsuleBlueprintDigestSchema } from '../blueprints'

export const CapsuleBranchResourceType = {
  INCUS_PROJECT: 'incus_project',
  INCUS_INSTANCE: 'incus_instance',
  ZFS_VOLUME: 'zfs_volume',
  BIND_MOUNT: 'bind_mount',
  PROVISIONING_FILE: 'provisioning_file',
} as const

export type CapsuleBranchResourceTypeValue = (typeof CapsuleBranchResourceType)[keyof typeof CapsuleBranchResourceType]

export const CapsuleBranchResourceTypeValues = [
  CapsuleBranchResourceType.INCUS_PROJECT,
  CapsuleBranchResourceType.INCUS_INSTANCE,
  CapsuleBranchResourceType.ZFS_VOLUME,
  CapsuleBranchResourceType.BIND_MOUNT,
  CapsuleBranchResourceType.PROVISIONING_FILE,
] as const

export const CapsuleBranchResourceTypeSchema = z.enum(CapsuleBranchResourceTypeValues)

export const CapsuleBranchResourceStatus = {
  PLANNED: 'planned',
  CREATING: 'creating',
  CREATED: 'created',
  DELETING: 'deleting',
  DELETED: 'deleted',
  ADOPTED: 'adopted',
  MISSING: 'missing',
  ERROR: 'error',
} as const

export type CapsuleBranchResourceStatusValue = (typeof CapsuleBranchResourceStatus)[keyof typeof CapsuleBranchResourceStatus]

export const CapsuleBranchResourceStatusValues = [
  CapsuleBranchResourceStatus.PLANNED,
  CapsuleBranchResourceStatus.CREATING,
  CapsuleBranchResourceStatus.CREATED,
  CapsuleBranchResourceStatus.DELETING,
  CapsuleBranchResourceStatus.DELETED,
  CapsuleBranchResourceStatus.ADOPTED,
  CapsuleBranchResourceStatus.MISSING,
  CapsuleBranchResourceStatus.ERROR,
] as const

export const CapsuleBranchResourceStatusSchema = z.enum(CapsuleBranchResourceStatusValues)

export const CapsuleBranchResourceCleanupPolicy = {
  DELETE_WITH_BRANCH: 'delete_with_branch',
  RETAIN: 'retain',
  EXTERNAL: 'external',
} as const

export type CapsuleBranchResourceCleanupPolicyValue =
  (typeof CapsuleBranchResourceCleanupPolicy)[keyof typeof CapsuleBranchResourceCleanupPolicy]

export const CapsuleBranchResourceCleanupPolicyValues = [
  CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH,
  CapsuleBranchResourceCleanupPolicy.RETAIN,
  CapsuleBranchResourceCleanupPolicy.EXTERNAL,
] as const

export const CapsuleBranchResourceCleanupPolicySchema = z.enum(CapsuleBranchResourceCleanupPolicyValues)

/**
 * Immutable digest of the complete branch resource identity planned before the
 * first provider mutation.
 */
export const CapsuleBranchResourceInventoryDigestSchema = CapsuleBlueprintDigestSchema

export type CapsuleBranchResourceInventoryDigest = z.infer<typeof CapsuleBranchResourceInventoryDigestSchema>
