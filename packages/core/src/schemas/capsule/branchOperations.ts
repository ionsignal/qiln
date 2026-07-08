import { z } from 'zod'
import { CapsuleBlueprintDigestSchema } from '../blueprints'

export const CapsuleBranchOperationType = {
  CREATE: 'create',
} as const

export type CapsuleBranchOperationType = (typeof CapsuleBranchOperationType)[keyof typeof CapsuleBranchOperationType]

export const CapsuleBranchOperationTypeValues = [CapsuleBranchOperationType.CREATE] as const
export const CapsuleBranchOperationTypeSchema = z.enum(CapsuleBranchOperationTypeValues)

export const CapsuleBranchOperationStatus = {
  ACCEPTED: 'accepted',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  RECOVERING: 'recovering',
  CLEANUP_REQUIRED: 'cleanup_required',
} as const

export type CapsuleBranchOperationStatus = (typeof CapsuleBranchOperationStatus)[keyof typeof CapsuleBranchOperationStatus]

export const CapsuleBranchOperationStatusValues = [
  CapsuleBranchOperationStatus.ACCEPTED,
  CapsuleBranchOperationStatus.RUNNING,
  CapsuleBranchOperationStatus.COMPLETED,
  CapsuleBranchOperationStatus.FAILED,
  CapsuleBranchOperationStatus.RECOVERING,
  CapsuleBranchOperationStatus.CLEANUP_REQUIRED,
] as const

export const CapsuleBranchOperationStatusSchema = z.enum(CapsuleBranchOperationStatusValues)

export const CapsuleBranchOperationStepStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
} as const

export type CapsuleBranchOperationStepStatus = (typeof CapsuleBranchOperationStepStatus)[keyof typeof CapsuleBranchOperationStepStatus]

export const CapsuleBranchOperationStepStatusValues = [
  CapsuleBranchOperationStepStatus.PENDING,
  CapsuleBranchOperationStepStatus.RUNNING,
  CapsuleBranchOperationStepStatus.COMPLETED,
  CapsuleBranchOperationStepStatus.FAILED,
  CapsuleBranchOperationStepStatus.SKIPPED,
] as const

export const CapsuleBranchOperationStepStatusSchema = z.enum(CapsuleBranchOperationStepStatusValues)

export const CapsuleBranchResourceType = {
  INCUS_PROJECT: 'incus_project',
  INCUS_INSTANCE: 'incus_instance',
  ZFS_VOLUME: 'zfs_volume',
  BIND_MOUNT: 'bind_mount',
  PROVISIONING_FILE: 'provisioning_file',
} as const

export type CapsuleBranchResourceType = (typeof CapsuleBranchResourceType)[keyof typeof CapsuleBranchResourceType]

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
  ORPHANED: 'orphaned',
  ERROR: 'error',
} as const

export type CapsuleBranchResourceStatus = (typeof CapsuleBranchResourceStatus)[keyof typeof CapsuleBranchResourceStatus]

export const CapsuleBranchResourceStatusValues = [
  CapsuleBranchResourceStatus.PLANNED,
  CapsuleBranchResourceStatus.CREATING,
  CapsuleBranchResourceStatus.CREATED,
  CapsuleBranchResourceStatus.DELETING,
  CapsuleBranchResourceStatus.DELETED,
  CapsuleBranchResourceStatus.ADOPTED,
  CapsuleBranchResourceStatus.MISSING,
  CapsuleBranchResourceStatus.ORPHANED,
  CapsuleBranchResourceStatus.ERROR,
] as const

export const CapsuleBranchResourceStatusSchema = z.enum(CapsuleBranchResourceStatusValues)

export const CapsuleBranchResourceCleanupPolicy = {
  DELETE_ON_ROLLBACK: 'delete_on_rollback',
  RETAIN: 'retain',
  EXTERNAL: 'external',
} as const

export type CapsuleBranchResourceCleanupPolicy = (typeof CapsuleBranchResourceCleanupPolicy)[keyof typeof CapsuleBranchResourceCleanupPolicy]

export const CapsuleBranchResourceCleanupPolicyValues = [
  CapsuleBranchResourceCleanupPolicy.DELETE_ON_ROLLBACK,
  CapsuleBranchResourceCleanupPolicy.RETAIN,
  CapsuleBranchResourceCleanupPolicy.EXTERNAL,
] as const

export const CapsuleBranchResourceCleanupPolicySchema = z.enum(CapsuleBranchResourceCleanupPolicyValues)

export const CapsuleBranchIdempotencyKeySchema = z.uuid()

export const CapsuleBranchOperationRequestHashSchema = CapsuleBlueprintDigestSchema

export const CapsuleBranchBlueprintReferenceSchema = z
  .object({
    blueprintName: z.string().trim().min(1, 'Capsule blueprint name cannot be empty.'),
    blueprintDigest: CapsuleBlueprintDigestSchema,
  })
  .strict()

export const CapsuleBranchOperationReceiptSchema = z
  .object({
    operationId: z.uuid(),
    operationType: CapsuleBranchOperationTypeSchema,
    operationStatus: CapsuleBranchOperationStatusSchema,
    replayed: z.boolean(),
  })
  .strict()

export type CapsuleBranchIdempotencyKey = z.infer<typeof CapsuleBranchIdempotencyKeySchema>
export type CapsuleBranchOperationRequestHash = z.infer<typeof CapsuleBranchOperationRequestHashSchema>
export type CapsuleBranchBlueprintReference = z.infer<typeof CapsuleBranchBlueprintReferenceSchema>
export type CapsuleBranchOperationReceipt = z.infer<typeof CapsuleBranchOperationReceiptSchema>
