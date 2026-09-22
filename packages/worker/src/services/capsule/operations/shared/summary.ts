import { CapsuleOperationSummarySchema, type CapsuleOperationSummary, type CapsuleTables } from '@qiln/core/server'
import { IncusError } from '../../../../errors'
import { toClientSafeOperationFailure } from './operationFailure'
import { toIsoTimestamp, toNullableIsoTimestamp } from './timestamps'

type OperationRow = CapsuleTables['capsuleOperations']['$inferSelect']

/**
 * Projects durable operation evidence without exposing provider diagnostics.
 * Callers own authorization and the consistency of the surrounding read.
 */
export function operationSummary(operation: OperationRow): CapsuleOperationSummary {
  const nonterminal = operation.status === 'accepted' || operation.status === 'running'
  if (
    nonterminal &&
    (operation.completedAt !== null ||
      operation.failedAt !== null ||
      operation.failureCode !== null ||
      operation.failureMessage !== null ||
      operation.failureDetails !== null ||
      (operation.status === 'accepted' &&
        (operation.executionStartedAt !== null || operation.providerMutationStartedAt !== null)) ||
      (operation.status === 'running' && operation.executionStartedAt === null))
  ) {
    throw new IncusError('Current capsule operation contains contradictory execution evidence.', 'CONFLICT', {
      operationId: operation.id,
    })
  }
  const context = {
    entity: 'capsule operation',
    entityId: operation.id,
  }
  return CapsuleOperationSummarySchema.parse({
    id: operation.id,
    capsuleId: operation.capsuleId,
    actor: {
      type: operation.actorType,
      id: operation.actorId,
    },
    type: operation.type,
    status: operation.status,
    acceptedAt: toIsoTimestamp(operation.acceptedAt, 'acceptedAt', context),
    executionStartedAt: toNullableIsoTimestamp(operation.executionStartedAt, 'executionStartedAt', context),
    providerMutationStartedAt: toNullableIsoTimestamp(
      operation.providerMutationStartedAt,
      'providerMutationStartedAt',
      context,
    ),
    completedAt: toNullableIsoTimestamp(operation.completedAt, 'completedAt', context),
    failedAt: toNullableIsoTimestamp(operation.failedAt, 'failedAt', context),
    failure: toClientSafeOperationFailure(operation),
  })
}
