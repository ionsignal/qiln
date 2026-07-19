import type {
  CapsuleActorReference,
  CapsuleBlueprint,
  CapsuleOperationStatusValue,
  CapsuleOperationStepStatusValue,
  CapsuleOperationTypeValue,
} from '@qiln/core/server'

/**
 * Read-only durable operation shape used by operation repositories and startup
 * abandoned-operation classification.
 *
 * PostgreSQL remains authoritative. This record does not authorize execution,
 * replay, retry, aggregate restoration, or provider mutation.
 */
export interface PersistedCapsuleOperation {
  id: string
  ownerId: string
  actor: CapsuleActorReference
  capsuleId: string
  branchId: string | null
  branchName: string | null
  type: CapsuleOperationTypeValue
  status: CapsuleOperationStatusValue
  idempotencyKey: string
  requestHash: string
  blueprintName: string | null
  blueprintDigest: string | null
  blueprintSnapshot: CapsuleBlueprint | null
  acceptedAt: Date
  executionStartedAt: Date | null
  providerMutationStartedAt: Date | null
  completedAt: Date | null
  failedAt: Date | null
  failureCode: string | null
  failureMessage: string | null
  failureDetails: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Generic committed operation identity suitable for operation invalidation
 * events.
 *
 * Operation-specific repositories may extend their committed outputs with
 * capsule lifecycle or branch state, but the shared publisher consumes only
 * these client-safe fields. Actor provenance is intentionally omitted because
 * clients refetch authoritative operation summaries after invalidation.
 */
export interface CapsuleOperationTransitionOutput {
  ownerId: string
  operationId: string
  operationType: CapsuleOperationTypeValue
  operationStatus: CapsuleOperationStatusValue
  capsuleId: string
  branchId: string | null
}

/**
 * Mechanical identity for one operation-step accounting row.
 *
 * A step row is an inspection record only. It is never an execution checkpoint
 * and cannot authorize work to resume, retry, skip, or replay.
 */
export interface CapsuleOperationStepInput {
  operationId: string
  capsuleId: string
  ownerId: string
  branchId?: string | null
  branchName?: string | null
  stepKey: string
  status?: CapsuleOperationStepStatusValue
  metadata?: Record<string, unknown>
}

export interface AbandonedOperationStepFailureInput {
  operationId: string
  failureCode: string
  failureMessage: string
  context: Record<string, unknown>
}
