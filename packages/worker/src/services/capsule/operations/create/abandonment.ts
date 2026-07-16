import { CapsuleOperationType } from '@qiln/core/server'
import {
  assertAbandonedOperationTransitionIdentity,
  assertAbandonedOperationTransitionTerminal,
  assertAbandonedOperationType,
  type CapsuleOperationAbandonmentClassificationResult,
  type CapsuleOperationAbandonmentHandler,
} from '../abandonment'
import type { CapsuleBranchEventPublisher, CapsuleLifecycleEventPublisher, CapsuleOperationEventPublisher } from '../../events'
import type { PersistedCapsuleOperation } from '../shared'
import type { CreateCapsuleOperationRepository } from './repository'
import type { CreateCapsuleTerminalResult } from './types'

export interface CreateCapsuleAbandonmentHandlerDependencies {
  repository: CreateCapsuleOperationRepository
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
  branchEvents: CapsuleBranchEventPublisher
}

function assertCreateAbandonmentRelationships(result: CreateCapsuleTerminalResult): void {
  if (result.capsule.capsuleId !== result.operation.capsuleId) {
    throw new Error(
      `[CreateCapsuleAbandonmentHandler] Lifecycle result belongs to capsule '${result.capsule.capsuleId}', but operation '${result.operation.operationId}' belongs to capsule '${result.operation.capsuleId}'.`,
    )
  }
  if (!result.branch) {
    return
  }
  if (result.branch.capsuleId !== result.operation.capsuleId) {
    throw new Error(
      `[CreateCapsuleAbandonmentHandler] Branch '${result.branch.id}' belongs to capsule '${result.branch.capsuleId}', but operation '${result.operation.operationId}' belongs to capsule '${result.operation.capsuleId}'.`,
    )
  }
  if (result.operation.branchId !== result.branch.id) {
    throw new Error(
      `[CreateCapsuleAbandonmentHandler] Operation '${result.operation.operationId}' references branch '${result.operation.branchId ?? 'null'}', but its committed branch result is '${result.branch.id}'.`,
    )
  }
}

/**
 * Applies create-specific startup abandonment policy.
 *
 * The create repository owns the classification transaction and decides whether
 * the durable evidence proves a safe pre-provider failure or requires manual
 * cleanup. This adapter publishes invalidations only from the repository's
 * committed result.
 */
export class CreateCapsuleAbandonmentHandler implements CapsuleOperationAbandonmentHandler {
  public readonly operationType = CapsuleOperationType.CREATE

  constructor(private readonly dependencies: CreateCapsuleAbandonmentHandlerDependencies) {}

  public async classify(operation: PersistedCapsuleOperation): Promise<CapsuleOperationAbandonmentClassificationResult> {
    assertAbandonedOperationType(operation, this.operationType)

    const result = await this.dependencies.repository.classifyAbandoned(operation.id)
    if (!result) {
      return {
        classified: false,
      }
    }

    assertAbandonedOperationTransitionIdentity(operation, result.operation)
    assertAbandonedOperationTransitionTerminal(result.operation)
    assertCreateAbandonmentRelationships(result)

    this.dependencies.operationEvents.publishChanged(result.operation)
    this.dependencies.lifecycleEvents.publishChanged(result.operation.ownerId, result.capsule)
    if (result.branch) {
      this.dependencies.branchEvents.publishStateChanged(
        result.operation.ownerId,
        result.branch.capsuleId,
        result.branch.name,
        result.branch.status,
      )
    }
    return {
      classified: true,
      operation: result.operation,
    }
  }
}
