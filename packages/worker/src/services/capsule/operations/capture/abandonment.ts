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
import type { CaptureRepository } from './persistence'
import type { CaptureTerminalResult } from './types'

export interface CaptureAbandonmentDependencies {
  repository: CaptureRepository
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
  branchEvents: CapsuleBranchEventPublisher
}

function assertRelationships(result: CaptureTerminalResult): void {
  if (result.capsule.capsuleId !== result.operation.capsuleId) {
    throw new Error(
      `[CaptureAbandonment] Lifecycle result belongs to capsule '${result.capsule.capsuleId}', but operation '${result.operation.operationId}' belongs to capsule '${result.operation.capsuleId}'.`,
    )
  }
  for (const branch of result.branches) {
    if (branch.capsuleId !== result.operation.capsuleId) {
      throw new Error(
        `[CaptureAbandonment] Branch '${branch.id}' belongs to capsule '${branch.capsuleId}', but operation '${result.operation.operationId}' belongs to capsule '${result.operation.capsuleId}'.`,
      )
    }
  }
}

/**
 * Applies Snapshot Capture startup abandonment policy without invoking an
 * executor or consulting provider state.
 */
export class CaptureAbandonment implements CapsuleOperationAbandonmentHandler {
  public readonly operationType = CapsuleOperationType.SNAPSHOT_CAPTURE

  constructor(private readonly dependencies: CaptureAbandonmentDependencies) {}

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
