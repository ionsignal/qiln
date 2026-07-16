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
import type { DestroyCapsuleOperationRepository } from './repository'
import type { DestroyCapsuleTerminalResult } from './types'

export interface DestroyCapsuleAbandonmentHandlerDependencies {
  repository: DestroyCapsuleOperationRepository
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
  branchEvents: CapsuleBranchEventPublisher
}

function assertDestroyAbandonmentRelationships(result: DestroyCapsuleTerminalResult): void {
  if (result.capsule.capsuleId !== result.operation.capsuleId) {
    throw new Error(
      `[DestroyCapsuleAbandonmentHandler] Lifecycle result belongs to capsule '${result.capsule.capsuleId}', but operation '${result.operation.operationId}' belongs to capsule '${result.operation.capsuleId}'.`,
    )
  }
  for (const branch of result.branches) {
    if (branch.capsuleId !== result.operation.capsuleId) {
      throw new Error(
        `[DestroyCapsuleAbandonmentHandler] Branch '${branch.id}' belongs to capsule '${branch.capsuleId}', but operation '${result.operation.operationId}' belongs to capsule '${result.operation.capsuleId}'.`,
      )
    }
  }
}

/**
 * Applies destroy-specific startup abandonment policy.
 *
 * The destroy repository owns the classification transaction and decides
 * whether the durable evidence proves an intact pre-provider destroy fence or
 * requires cleanup after provider intent or contradictory aggregate state.
 * This adapter publishes invalidations only from committed repository output.
 */
export class DestroyCapsuleAbandonmentHandler implements CapsuleOperationAbandonmentHandler {
  public readonly operationType = CapsuleOperationType.DESTROY

  constructor(private readonly dependencies: DestroyCapsuleAbandonmentHandlerDependencies) {}

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
    assertDestroyAbandonmentRelationships(result)

    this.dependencies.operationEvents.publishChanged(result.operation)
    this.dependencies.lifecycleEvents.publishChanged(result.operation.ownerId, result.capsule)
    for (const branch of result.branches) {
      this.dependencies.branchEvents.publishStateChanged(result.operation.ownerId, branch.capsuleId, branch.name, branch.status)
    }
    return {
      classified: true,
      operation: result.operation,
    }
  }
}
