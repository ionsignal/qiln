import { z } from 'zod'
import { CapsuleBlueprintDigestSchema } from '../blueprints'

export const CapsuleOperationType = {
  BRANCH_CREATE: 'branch_create',
} as const

export type CapsuleOperationType = (typeof CapsuleOperationType)[keyof typeof CapsuleOperationType]

export const CapsuleOperationTypeValues = [CapsuleOperationType.BRANCH_CREATE] as const
export const CapsuleOperationTypeSchema = z.enum(CapsuleOperationTypeValues)

export const CapsuleOperationStatus = {
  ACCEPTED: 'accepted',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  RECOVERING: 'recovering',
  CLEANUP_REQUIRED: 'cleanup_required',
} as const

export type CapsuleOperationStatus = (typeof CapsuleOperationStatus)[keyof typeof CapsuleOperationStatus]

export const CapsuleOperationStatusValues = [
  CapsuleOperationStatus.ACCEPTED,
  CapsuleOperationStatus.RUNNING,
  CapsuleOperationStatus.COMPLETED,
  CapsuleOperationStatus.FAILED,
  CapsuleOperationStatus.RECOVERING,
  CapsuleOperationStatus.CLEANUP_REQUIRED,
] as const

export const CapsuleOperationStatusSchema = z.enum(CapsuleOperationStatusValues)

export const CapsuleOperationResourceType = {
  INCUS_PROJECT: 'incus_project',
  INCUS_INSTANCE: 'incus_instance',
  ZFS_VOLUME: 'zfs_volume',
  BIND_MOUNT: 'bind_mount',
  PROVISIONING_FILE: 'provisioning_file',
} as const

export type CapsuleOperationResourceType = (typeof CapsuleOperationResourceType)[keyof typeof CapsuleOperationResourceType]

export const CapsuleOperationResourceTypeValues = [
  CapsuleOperationResourceType.INCUS_PROJECT,
  CapsuleOperationResourceType.INCUS_INSTANCE,
  CapsuleOperationResourceType.ZFS_VOLUME,
  CapsuleOperationResourceType.BIND_MOUNT,
  CapsuleOperationResourceType.PROVISIONING_FILE,
] as const

export const CapsuleOperationResourceTypeSchema = z.enum(CapsuleOperationResourceTypeValues)

export const CapsuleOperationResourceStatus = {
  PLANNED: 'planned',
  CREATING: 'creating',
  CREATED: 'created',
  DELETING: 'deleting',
  DELETED: 'deleted',
  ADOPTED: 'adopted',
  MISSING: 'missing',
  ORPHANED: 'orphaned',
  ERROR: 'error',
} as const

export type CapsuleOperationResourceStatus = (typeof CapsuleOperationResourceStatus)[keyof typeof CapsuleOperationResourceStatus]

export const CapsuleOperationResourceStatusValues = [
  CapsuleOperationResourceStatus.PLANNED,
  CapsuleOperationResourceStatus.CREATING,
  CapsuleOperationResourceStatus.CREATED,
  CapsuleOperationResourceStatus.DELETING,
  CapsuleOperationResourceStatus.DELETED,
  CapsuleOperationResourceStatus.ADOPTED,
  CapsuleOperationResourceStatus.MISSING,
  CapsuleOperationResourceStatus.ORPHANED,
  CapsuleOperationResourceStatus.ERROR,
] as const

export const CapsuleOperationResourceStatusSchema = z.enum(CapsuleOperationResourceStatusValues)

export const CapsuleOperationCleanupPolicy = {
  DELETE_ON_ROLLBACK: 'delete_on_rollback',
  RETAIN: 'retain',
  EXTERNAL: 'external',
} as const

export type CapsuleOperationCleanupPolicy = (typeof CapsuleOperationCleanupPolicy)[keyof typeof CapsuleOperationCleanupPolicy]

export const CapsuleOperationCleanupPolicyValues = [
  CapsuleOperationCleanupPolicy.DELETE_ON_ROLLBACK,
  CapsuleOperationCleanupPolicy.RETAIN,
  CapsuleOperationCleanupPolicy.EXTERNAL,
] as const

export const CapsuleOperationCleanupPolicySchema = z.enum(CapsuleOperationCleanupPolicyValues)

export const CapsuleIdempotencyKeySchema = z.uuid()

export const CapsuleOperationRequestHashSchema = CapsuleBlueprintDigestSchema

export const CapsuleBlueprintReferenceSchema = z
  .object({
    blueprintName: z.string().trim().min(1, 'Capsule blueprint name cannot be empty.'),
    blueprintDigest: CapsuleBlueprintDigestSchema,
  })
  .strict()

export const CapsuleOperationReceiptSchema = z
  .object({
    operationId: z.uuid(),
    operationType: CapsuleOperationTypeSchema,
    operationStatus: CapsuleOperationStatusSchema,
    replayed: z.boolean(),
  })
  .strict()

export type CapsuleIdempotencyKey = z.infer<typeof CapsuleIdempotencyKeySchema>
export type CapsuleOperationRequestHash = z.infer<typeof CapsuleOperationRequestHashSchema>
export type CapsuleBlueprintReference = z.infer<typeof CapsuleBlueprintReferenceSchema>
export type CapsuleOperationReceipt = z.infer<typeof CapsuleOperationReceiptSchema>
