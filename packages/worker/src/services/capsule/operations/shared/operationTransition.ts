import type { CapsuleOperationStatusValue, CapsuleOperationTypeValue } from '@qiln/core/server'
import type { CapsuleOperationTransitionOutput } from './types'

export interface CapsuleOperationTransitionInput {
  ownerId: string
  operationId: string
  operationType: CapsuleOperationTypeValue
  operationStatus: CapsuleOperationStatusValue
  capsuleId: string
}

/**
 * Maps a committed base-operation record into the narrow identity used by
 * invalidation publishers and operation-specific repository results.
 *
 * Operation-specific branch, snapshot, route, and promotion references belong
 * to their extension tables and domain-result projections.
 *
 * Callers remain responsible for choosing the operation type and committed
 * status. This helper performs no lifecycle policy, database work, or event
 * publication.
 */
export function toCapsuleOperationTransition(input: CapsuleOperationTransitionInput): CapsuleOperationTransitionOutput {
  return {
    ownerId: input.ownerId,
    operationId: input.operationId,
    operationType: input.operationType,
    operationStatus: input.operationStatus,
    capsuleId: input.capsuleId,
  }
}
