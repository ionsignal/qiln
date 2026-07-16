import type { CapsuleOperationRequestHash, CapsuleOperationTypeValue } from '@qiln/core/server'
import { IncusError } from '../../../../errors'

export interface PersistedOperationReplayIdentity {
  id: string
  type: CapsuleOperationTypeValue
  requestHash: string
}

export interface ExpectedOperationReplayIdentity {
  operationType: CapsuleOperationTypeValue
  requestHash: CapsuleOperationRequestHash
  requestDescription: string
}

/**
 * Verifies the mechanical identity of an idempotent operation replay.
 *
 * This helper does not decide when replay lookup occurs. Submission services
 * may perform an early lookup before consulting mutable inputs, while
 * repositories must still repeat the lookup for race-safe durable acceptance.
 */
export function assertOperationReplayIdentity(operation: PersistedOperationReplayIdentity, expected: ExpectedOperationReplayIdentity): void {
  if (operation.type !== expected.operationType) {
    throw new IncusError('Idempotency key was already used for another capsule operation type.', 'CONFLICT', {
      operationId: operation.id,
      existingOperationType: operation.type,
      requestedOperationType: expected.operationType,
    })
  }
  if (operation.requestHash !== expected.requestHash) {
    throw new IncusError(`Idempotency key was already used with different ${expected.requestDescription} input.`, 'CONFLICT', {
      operationId: operation.id,
      operationType: operation.type,
    })
  }
}
