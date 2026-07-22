import type { CapsuleActorReference, CapsuleOperationRequestHash, CapsuleOperationTypeValue } from '@qiln/core/server'
import { IncusError } from '../../../../errors'

export interface PersistedOperationReplayIdentity {
  id: string
  type: CapsuleOperationTypeValue
  requestHash: string
  actor: CapsuleActorReference
}

export interface ExpectedOperationReplayIdentity {
  operationType: CapsuleOperationTypeValue
  requestHash: CapsuleOperationRequestHash
  requestDescription: string
  actor: CapsuleActorReference
}

/**
 * Verifies the mechanical identity of an idempotent operation replay.
 *
 * Actor provenance is checked independently from the request hash so replay
 * authorization does not depend solely on hash construction remaining correct.
 *
 * This helper does not decide when replay lookup occurs. Submission services
 * may perform an early lookup before consulting mutable inputs, while
 * repositories must still repeat the lookup for race-safe durable acceptance.
 */
export function assertOperationReplayIdentity(
  operation: PersistedOperationReplayIdentity,
  expected: ExpectedOperationReplayIdentity,
): void {
  if (operation.type !== expected.operationType) {
    throw new IncusError('Idempotency key was already used for another capsule operation type.', 'CONFLICT', {
      operationId: operation.id,
      existingOperationType: operation.type,
      requestedOperationType: expected.operationType,
    })
  }
  if (operation.actor.type !== expected.actor.type || operation.actor.id !== expected.actor.id) {
    throw new IncusError('Idempotency key was already used by another capsule operation actor.', 'CONFLICT', {
      operationId: operation.id,
      operationType: operation.type,
    })
  }
  if (operation.requestHash !== expected.requestHash) {
    throw new IncusError(
      `Idempotency key was already used with different ${expected.requestDescription} input.`,
      'CONFLICT',
      {
        operationId: operation.id,
        operationType: operation.type,
      },
    )
  }
}
