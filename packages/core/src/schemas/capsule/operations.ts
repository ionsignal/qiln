import { z } from 'zod'
import { CapsuleActorReferenceSchema } from './actor'
import { CapsuleBranchNameSchema } from './branch'

/**
 * Durable control-plane mutation types for a capsule aggregate.
 *
 * `create` initializes the capsule aggregate and its root editable branch.
 * Future snapshot capture and branch fork operations will extend this
 * vocabulary only after Qiln can prove their artifact and provider ownership
 * boundaries.
 */
export const CapsuleOperationType = {
  CREATE: 'create',
  ARCHIVE: 'archive',
  UNARCHIVE: 'unarchive',
  DESTROY: 'destroy',
} as const

export type CapsuleOperationTypeValue = (typeof CapsuleOperationType)[keyof typeof CapsuleOperationType]

export const CapsuleOperationTypeValues = [
  CapsuleOperationType.CREATE,
  CapsuleOperationType.ARCHIVE,
  CapsuleOperationType.UNARCHIVE,
  CapsuleOperationType.DESTROY,
] as const

export const CapsuleOperationTypeSchema = z.enum(CapsuleOperationTypeValues)

/**
 * Durable execution state for one capsule control-plane operation.
 *
 * A nonterminal operation is never resumed after Worker process loss. The
 * Worker either safely classifies it as failed before provider intent or marks
 * the affected aggregate cleanup_required when provider state is uncertain.
 */
export const CapsuleOperationStatus = {
  ACCEPTED: 'accepted',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CLEANUP_REQUIRED: 'cleanup_required',
} as const

export type CapsuleOperationStatusValue = (typeof CapsuleOperationStatus)[keyof typeof CapsuleOperationStatus]

export const CapsuleOperationStatusValues = [
  CapsuleOperationStatus.ACCEPTED,
  CapsuleOperationStatus.RUNNING,
  CapsuleOperationStatus.COMPLETED,
  CapsuleOperationStatus.FAILED,
  CapsuleOperationStatus.CLEANUP_REQUIRED,
] as const

export const CapsuleOperationStatusSchema = z.enum(CapsuleOperationStatusValues)

/**
 * Durable inspection state for one inline capsule operation step.
 *
 * Step rows are accounting records. They are not a queue, checkpoint, retry
 * mechanism, or authorization to resume an interrupted provider mutation.
 */
export const CapsuleOperationStepStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const

export type CapsuleOperationStepStatusValue =
  (typeof CapsuleOperationStepStatus)[keyof typeof CapsuleOperationStepStatus]

export const CapsuleOperationStepStatusValues = [
  CapsuleOperationStepStatus.PENDING,
  CapsuleOperationStepStatus.RUNNING,
  CapsuleOperationStepStatus.COMPLETED,
  CapsuleOperationStepStatus.FAILED,
] as const

export const CapsuleOperationStepStatusSchema = z.enum(CapsuleOperationStepStatusValues)

export const CapsuleOperationIdempotencyKeySchema = z.uuid()
export const CapsuleOperationRequestHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, {
  message: "Capsule operation request hashes must use the format 'sha256:<64 lowercase hex characters>'.",
})

export const CapsuleOperationTimestampSchema = z.string().datetime({
  offset: true,
})

/**
 * Client-safe operation receipt returned by mutation commands.
 *
 * A receipt proves Qiln durably accepted or replayed an operation. It does not
 * claim that an asynchronous provider mutation has completed.
 */
export const CapsuleOperationReceiptSchema = z
  .object({
    operationId: z.uuid(),
    operationType: CapsuleOperationTypeSchema,
    operationStatus: CapsuleOperationStatusSchema,
    capsuleId: z.uuid(),
    replayed: z.boolean(),
  })
  .strict()

export const CapsuleCreateReceiptSchema = CapsuleOperationReceiptSchema.extend({
  operationType: z.literal(CapsuleOperationType.CREATE),
  rootBranchId: z.uuid(),
  rootBranchName: CapsuleBranchNameSchema,
}).strict()

export const CapsuleArchiveReceiptSchema = CapsuleOperationReceiptSchema.extend({
  operationType: z.literal(CapsuleOperationType.ARCHIVE),
}).strict()

export const CapsuleUnarchiveReceiptSchema = CapsuleOperationReceiptSchema.extend({
  operationType: z.literal(CapsuleOperationType.UNARCHIVE),
}).strict()

export const CapsuleDestroyReceiptSchema = CapsuleOperationReceiptSchema.extend({
  operationType: z.literal(CapsuleOperationType.DESTROY),
}).strict()

/**
 * Sanitized operation failure visible to authenticated capsule owners.
 *
 * Raw provider diagnostics remain server-only persistence details. This shape
 * deliberately excludes host paths, provider payloads, stacks, and secrets.
 */
export const CapsuleOperationFailureSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    occurredAt: CapsuleOperationTimestampSchema,
  })
  .strict()

/**
 * Authoritative client-safe durable operation state.
 *
 * Actor provenance identifies the principal that authored the operation and is
 * intentionally distinct from capsule ownership.
 *
 * Operation-specific domain references are exposed through operation-specific
 * receipts and domain reads rather than through this shared summary.
 */
export const CapsuleOperationSummarySchema = z
  .object({
    id: z.uuid(),
    capsuleId: z.uuid(),
    actor: CapsuleActorReferenceSchema,
    type: CapsuleOperationTypeSchema,
    status: CapsuleOperationStatusSchema,
    acceptedAt: CapsuleOperationTimestampSchema,
    executionStartedAt: CapsuleOperationTimestampSchema.nullable(),
    providerMutationStartedAt: CapsuleOperationTimestampSchema.nullable(),
    completedAt: CapsuleOperationTimestampSchema.nullable(),
    failedAt: CapsuleOperationTimestampSchema.nullable(),
    failure: CapsuleOperationFailureSchema.nullable(),
  })
  .strict()

export type CapsuleOperationIdempotencyKey = z.infer<typeof CapsuleOperationIdempotencyKeySchema>
export type CapsuleOperationRequestHash = z.infer<typeof CapsuleOperationRequestHashSchema>
export type CapsuleOperationReceipt = z.infer<typeof CapsuleOperationReceiptSchema>
export type CapsuleCreateReceipt = z.infer<typeof CapsuleCreateReceiptSchema>
export type CapsuleArchiveReceipt = z.infer<typeof CapsuleArchiveReceiptSchema>
export type CapsuleUnarchiveReceipt = z.infer<typeof CapsuleUnarchiveReceiptSchema>
export type CapsuleDestroyReceipt = z.infer<typeof CapsuleDestroyReceiptSchema>
export type CapsuleOperationFailure = z.infer<typeof CapsuleOperationFailureSchema>
export type CapsuleOperationSummary = z.infer<typeof CapsuleOperationSummarySchema>
