import { CapsuleOperationType } from '@qiln/core/server'
import {
  assertAbandonedOperationTransitionIdentity,
  assertAbandonedOperationTransitionTerminal,
  assertAbandonedOperationType,
  type CapsuleOperationAbandonmentClassificationResult,
  type CapsuleOperationAbandonmentHandler,
} from '../../abandonment'
import type { CapsuleLifecycleEventPublisher, CapsuleOperationEventPublisher } from '../../../events'
import type { PersistedCapsuleOperation } from '../../shared'
import type { CapsuleUnarchiveRepository } from './repository'
import type { UnarchiveCapsuleTerminalResult } from './types'

export interface CapsuleUnarchiveAbandonmentHandlerDependencies {
  repository: CapsuleUnarchiveRepository
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
}

function assertUnarchiveAbandonmentRelationships(result: UnarchiveCapsuleTerminalResult): void {
  if (result.capsule.capsuleId === result.operation.capsuleId) {
    return
  }
  throw new Error(
    `[CapsuleUnarchiveAbandonmentHandler] Lifecycle result belongs to capsule '${result.capsule.capsuleId}', but operation '${result.operation.operationId}' belongs to capsule '${result.operation.capsuleId}'.`,
  )
}

/**
 * Applies unarchive-specific startup abandonment policy.
 *
 * Unarchive remains provider-free, but its repository owns validation of the
 * unarchive mutation fence, preservation of the original archive timestamp,
 * offline branch lineage, and cleanup-required classification. This adapter
 * publishes only committed operation and capsule state returned by that
 * repository.
 */
export class CapsuleUnarchiveAbandonmentHandler implements CapsuleOperationAbandonmentHandler {
  public readonly operationType = CapsuleOperationType.UNARCHIVE

  constructor(private readonly dependencies: CapsuleUnarchiveAbandonmentHandlerDependencies) {}

  public async classify(
    operation: PersistedCapsuleOperation,
  ): Promise<CapsuleOperationAbandonmentClassificationResult> {
    assertAbandonedOperationType(operation, this.operationType)

    const result = await this.dependencies.repository.classifyAbandoned(operation.id)
    if (!result) {
      return {
        classified: false,
      }
    }

    assertAbandonedOperationTransitionIdentity(operation, result.operation)
    assertAbandonedOperationTransitionTerminal(result.operation)
    assertUnarchiveAbandonmentRelationships(result)

    this.dependencies.operationEvents.publishChanged(result.operation)
    this.dependencies.lifecycleEvents.publishChanged(result.operation.ownerId, result.capsule)
    return {
      classified: true,
      operation: result.operation,
    }
  }
}
