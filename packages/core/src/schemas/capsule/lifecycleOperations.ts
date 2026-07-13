import { z } from 'zod'
import { CapsuleBlueprintDigestSchema } from '../blueprints'
import { CapsuleLifecycleStatusSchema, CapsuleLifecycleTimestampSchema } from './lifecycle'

/**
 * Durable capsule lifecycle operation types.
 */
export const CapsuleLifecycleOperationType = {
  BOOTSTRAP: 'bootstrap',
  ARCHIVE: 'archive',
  UNARCHIVE: 'unarchive',
  DESTROY: 'destroy',
} as const

export type CapsuleLifecycleOperationTypeValue = (typeof CapsuleLifecycleOperationType)[keyof typeof CapsuleLifecycleOperationType]

export const CapsuleLifecycleOperationTypeValues = [
  CapsuleLifecycleOperationType.BOOTSTRAP,
  CapsuleLifecycleOperationType.ARCHIVE,
  CapsuleLifecycleOperationType.UNARCHIVE,
  CapsuleLifecycleOperationType.DESTROY,
] as const

export const CapsuleLifecycleOperationTypeSchema = z.enum(CapsuleLifecycleOperationTypeValues)

export const CapsuleLifecycleOperationStatus = {
  ACCEPTED: 'accepted',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CLEANUP_REQUIRED: 'cleanup_required',
} as const

export type CapsuleLifecycleOperationStatusValue = (typeof CapsuleLifecycleOperationStatus)[keyof typeof CapsuleLifecycleOperationStatus]

export const CapsuleLifecycleOperationStatusValues = [
  CapsuleLifecycleOperationStatus.ACCEPTED,
  CapsuleLifecycleOperationStatus.RUNNING,
  CapsuleLifecycleOperationStatus.COMPLETED,
  CapsuleLifecycleOperationStatus.FAILED,
  CapsuleLifecycleOperationStatus.CLEANUP_REQUIRED,
] as const

export const CapsuleLifecycleOperationStatusSchema = z.enum(CapsuleLifecycleOperationStatusValues)

export const CapsuleLifecycleOperationStepStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const

export type CapsuleLifecycleOperationStepStatusValue =
  (typeof CapsuleLifecycleOperationStepStatus)[keyof typeof CapsuleLifecycleOperationStepStatus]

export const CapsuleLifecycleOperationStepStatusValues = [
  CapsuleLifecycleOperationStepStatus.PENDING,
  CapsuleLifecycleOperationStepStatus.RUNNING,
  CapsuleLifecycleOperationStepStatus.COMPLETED,
  CapsuleLifecycleOperationStepStatus.FAILED,
] as const

export const CapsuleLifecycleOperationStepStatusSchema = z.enum(CapsuleLifecycleOperationStepStatusValues)

export const CapsuleLifecycleIdempotencyKeySchema = z.uuid()
export const CapsuleLifecycleOperationRequestHashSchema = CapsuleBlueprintDigestSchema

/**
 * Common durable operation identity returned by capsule lifecycle commands.
 */
export const CapsuleLifecycleOperationReceiptSchema = z
  .object({
    operationId: z.uuid(),
    operationType: CapsuleLifecycleOperationTypeSchema,
    operationStatus: CapsuleLifecycleOperationStatusSchema,
    replayed: z.boolean(),
  })
  .strict()

/**
 * Capsule-level receipt returned by archive, unarchive, and destroy.
 *
 * A replay can expose the operation's current durable state without authorizing
 * another execution of provider mutations.
 */
export const CapsuleLifecycleReceiptSchema = CapsuleLifecycleOperationReceiptSchema.extend({
  capsuleId: z.uuid(),
  lifecycleStatus: CapsuleLifecycleStatusSchema,
  archivedAt: CapsuleLifecycleTimestampSchema.nullable(),
  destroyedAt: CapsuleLifecycleTimestampSchema.nullable(),
}).strict()

export type CapsuleLifecycleIdempotencyKey = z.infer<typeof CapsuleLifecycleIdempotencyKeySchema>
export type CapsuleLifecycleOperationRequestHash = z.infer<typeof CapsuleLifecycleOperationRequestHashSchema>
export type CapsuleLifecycleOperationReceipt = z.infer<typeof CapsuleLifecycleOperationReceiptSchema>
export type CapsuleLifecycleReceipt = z.infer<typeof CapsuleLifecycleReceiptSchema>
