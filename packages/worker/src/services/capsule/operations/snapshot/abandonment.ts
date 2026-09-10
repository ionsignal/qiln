import { CapsuleOperationType } from '@qiln/core/server'
import { IncusError } from '../../../../errors'
import {
  assertAbandonedOperationTransitionIdentity,
  assertAbandonedOperationTransitionTerminal,
  assertAbandonedOperationType,
  type CapsuleOperationAbandonmentClassificationResult,
  type CapsuleOperationAbandonmentHandler,
} from '../abandonment'
import type {
  CapsuleBranchEventPublisher,
  CapsuleLifecycleEventPublisher,
  CapsuleOperationEventPublisher,
} from '../../events'
import type { PersistedCapsuleOperation } from '../shared/types'
import type { SnapshotRepository } from './persistence'

export interface SnapshotAbandonmentDependencies {
  repository: SnapshotRepository
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
  branchEvents: CapsuleBranchEventPublisher
}

/**
 * Classifies abandoned snapshot operations using PostgreSQL evidence only.
 *
 * Even apparently compensated resources do not authorize startup execution,
 * deletion, or continuation of a previous process's work.
 */
export class SnapshotAbandonment implements CapsuleOperationAbandonmentHandler {
  public readonly operationType = CapsuleOperationType.SNAPSHOT_CREATE

  constructor(private readonly dependencies: SnapshotAbandonmentDependencies) {}

  public async classify(
    operation: PersistedCapsuleOperation,
  ): Promise<CapsuleOperationAbandonmentClassificationResult> {
    assertAbandonedOperationType(operation, this.operationType)
    const result = await this.dependencies.repository.fail({
      operationId: operation.id,
      error: new IncusError('Create Snapshot was abandoned by a previous Worker process.', 'API_ERROR', {
        operationId: operation.id,
        policy: 'never_resume_abandoned_snapshot_operations',
      }),
      origin: 'abandoned',
    })
    if (!result) {
      return {
        classified: false,
      }
    }
    assertAbandonedOperationTransitionIdentity(operation, result.operation)
    assertAbandonedOperationTransitionTerminal(result.operation)
    if (result.capsule.capsuleId !== operation.capsuleId) {
      throw new IncusError('Snapshot abandonment returned another capsule identity.', 'CONFLICT')
    }
    for (const branch of result.branches) {
      if (branch.capsuleId !== operation.capsuleId) {
        throw new IncusError('Snapshot abandonment returned a foreign branch identity.', 'CONFLICT')
      }
    }
    this.dependencies.operationEvents.publishChanged(result.operation)
    this.dependencies.lifecycleEvents.publishChanged(result.operation.ownerId, result.capsule)
    for (const branch of result.branches) {
      this.dependencies.branchEvents.publishStateChanged(
        result.operation.ownerId,
        branch.capsuleId,
        branch.name,
        branch.status,
      )
    }
    return {
      classified: true,
      operation: result.operation,
    }
  }
}
