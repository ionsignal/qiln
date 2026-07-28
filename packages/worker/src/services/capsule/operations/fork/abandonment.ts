import { CapsuleOperationType } from '@qiln/core/server'
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
import type { PersistedCapsuleOperation } from '../shared'
import type { ForkRepository } from './persistence'
import type { ForkTerminal } from './types'

export interface ForkAbandonmentDependencies {
  repository: ForkRepository
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
  branchEvents: CapsuleBranchEventPublisher
}

function assertRelationships(result: ForkTerminal): void {
  if (result.capsule.capsuleId !== result.operation.capsuleId) {
    throw new Error(
      `[ForkAbandonment] Lifecycle result belongs to capsule '${result.capsule.capsuleId}', but operation '${result.operation.operationId}' belongs to capsule '${result.operation.capsuleId}'.`,
    )
  }
  if (result.branch.capsuleId !== result.operation.capsuleId) {
    throw new Error(
      `[ForkAbandonment] Branch '${result.branch.id}' belongs to capsule '${result.branch.capsuleId}', but operation '${result.operation.operationId}' belongs to capsule '${result.operation.capsuleId}'.`,
    )
  }
}

/**
 * Applies fork-specific startup abandonment policy without invoking provider
 * execution, compensation, discovery, or replay.
 */
export class ForkAbandonment implements CapsuleOperationAbandonmentHandler {
  public readonly operationType = CapsuleOperationType.FORK

  constructor(private readonly dependencies: ForkAbandonmentDependencies) {}

  public async classify(
    operation: PersistedCapsuleOperation,
  ): Promise<CapsuleOperationAbandonmentClassificationResult> {
    assertAbandonedOperationType(operation, this.operationType)
    const result = await this.dependencies.repository.abandon(operation.id)
    if (!result) {
      return {
        classified: false,
      }
    }
    assertAbandonedOperationTransitionIdentity(operation, result.operation)
    assertAbandonedOperationTransitionTerminal(result.operation)
    assertRelationships(result)
    this.dependencies.operationEvents.publishChanged(result.operation)
    this.dependencies.lifecycleEvents.publishChanged(result.operation.ownerId, result.capsule)
    this.dependencies.branchEvents.publishStateChanged(
      result.operation.ownerId,
      result.branch.capsuleId,
      result.branch.name,
      result.branch.status,
    )
    return {
      classified: true,
      operation: result.operation,
    }
  }
}
