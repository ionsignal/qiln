import {
  assertAbandonedOperationTransitionIdentity,
  assertAbandonedOperationTransitionTerminal,
  assertAbandonedOperationType,
  type CapsuleOperationAbandonmentClassificationResult,
  type CapsuleOperationAbandonmentHandler,
} from '../abandonment'
import type { CapsuleBranchEventPublisher, CapsuleOperationEventPublisher } from '../../events'
import type { PersistedCapsuleOperation } from '../shared'
import type { BranchRepository } from './persistence/repository'
import type { BranchOperationType } from './types'

export interface BranchAbandonmentDependencies<TOperation extends BranchOperationType> {
  repository: Pick<BranchRepository<TOperation>, 'type' | 'classifyAbandoned'>
  operationEvents: CapsuleOperationEventPublisher
  branchEvents: CapsuleBranchEventPublisher
}

/**
 * Binds shared abandonment publication to one concrete operation discriminator.
 *
 * Classification never executes provider work. Invalidations are emitted only
 * after the repository commits and the returned identities are verified.
 */
export class BranchAbandonment<TOperation extends BranchOperationType> implements CapsuleOperationAbandonmentHandler {
  public readonly operationType: TOperation

  constructor(private readonly dependencies: BranchAbandonmentDependencies<TOperation>) {
    this.operationType = dependencies.repository.type
  }

  public async classify(
    operation: PersistedCapsuleOperation,
  ): Promise<CapsuleOperationAbandonmentClassificationResult> {
    assertAbandonedOperationType(operation, this.operationType)

    const result = await this.dependencies.repository.classifyAbandoned(operation.id)
    if (result === null) {
      return {
        classified: false,
      }
    }

    assertAbandonedOperationTransitionIdentity(operation, result.operation)
    assertAbandonedOperationTransitionTerminal(result.operation)

    if (result.branch !== null && result.branch.capsuleId !== result.operation.capsuleId) {
      throw new Error(
        `Branch abandonment returned branch '${result.branch.id}' from another capsule for operation '${operation.id}'.`,
      )
    }
    if (result.branchChanged && result.branch === null) {
      throw new Error(
        `Branch abandonment reported a branch transition without a committed branch for operation '${operation.id}'.`,
      )
    }
    this.dependencies.operationEvents.publishChanged(result.operation)
    if (result.branch !== null && result.branchChanged) {
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
