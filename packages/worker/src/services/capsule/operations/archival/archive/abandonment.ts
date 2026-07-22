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
import type { CapsuleArchiveRepository } from './repository'
import type { ArchiveCapsuleTerminalResult } from './types'

export interface CapsuleArchiveAbandonmentHandlerDependencies {
  repository: CapsuleArchiveRepository
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
}

function assertArchiveAbandonmentRelationships(result: ArchiveCapsuleTerminalResult): void {
  if (result.capsule.capsuleId === result.operation.capsuleId) {
    return
  }
  throw new Error(
    `[CapsuleArchiveAbandonmentHandler] Lifecycle result belongs to capsule '${result.capsule.capsuleId}', but operation '${result.operation.operationId}' belongs to capsule '${result.operation.capsuleId}'.`,
  )
}

/**
 * Applies archive-specific startup abandonment policy.
 *
 * Archive is provider-free, but its repository still owns validation of the
 * archive mutation fence, offline branch lineage, timestamp policy, and
 * cleanup-required classification. This adapter publishes only committed
 * operation and capsule state returned by that repository.
 */
export class CapsuleArchiveAbandonmentHandler implements CapsuleOperationAbandonmentHandler {
  public readonly operationType = CapsuleOperationType.ARCHIVE

  constructor(private readonly dependencies: CapsuleArchiveAbandonmentHandlerDependencies) {}

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
    assertArchiveAbandonmentRelationships(result)

    this.dependencies.operationEvents.publishChanged(result.operation)
    this.dependencies.lifecycleEvents.publishChanged(result.operation.ownerId, result.capsule)
    return {
      classified: true,
      operation: result.operation,
    }
  }
}
