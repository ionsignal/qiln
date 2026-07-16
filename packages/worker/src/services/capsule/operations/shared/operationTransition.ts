import type { CapsuleOperationStatusValue, CapsuleOperationTypeValue } from '@qiln/core/server'
import type { CapsuleOperationTransitionOutput } from './types'

export interface CapsuleOperationTransitionInput {
  ownerId: string
  operationId: string
  operationType: CapsuleOperationTypeValue
  operationStatus: CapsuleOperationStatusValue
  capsuleId: string
  branchId: string | null
}

/**
 * Maps a committed operation record into the narrow identity used by
 * invalidation publishers and operation-specific repository results.
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
    branchId: input.branchId,
  }
}
