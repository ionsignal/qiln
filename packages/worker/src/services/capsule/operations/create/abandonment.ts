import { CapsuleOperationType, type CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
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
import type { CapsuleCreateRepository } from './persistence/repository'
import type { CapsuleCreateTerminalResult } from './types'

export interface CapsuleCreateAbandonmentHandlerDependencies<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  repository: CapsuleCreateRepository<TDatabase, TTables>
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
  branchEvents: CapsuleBranchEventPublisher
}

function assertCapsuleCreateAbandonmentRelationships(result: CapsuleCreateTerminalResult): void {
  if (result.capsule.capsuleId !== result.operation.capsuleId) {
    throw new Error(
      `[CapsuleCreateAbandonmentHandler] Lifecycle result belongs to capsule '${result.capsule.capsuleId}', but operation '${result.operation.operationId}' belongs to capsule '${result.operation.capsuleId}'.`,
    )
  }
  if (!result.branch) {
    return
  }
  if (result.branch.capsuleId !== result.operation.capsuleId) {
    throw new Error(
      `[CapsuleCreateAbandonmentHandler] Branch '${result.branch.id}' belongs to capsule '${result.branch.capsuleId}', but operation '${result.operation.operationId}' belongs to capsule '${result.operation.capsuleId}'.`,
    )
  }
}

/**
 * Applies create-specific startup abandonment policy through the repository
 * facade.
 *
 * The classification capability owns the transaction and decides whether the
 * durable base operation, create extension, root branch, and provider fence
 * prove a safe pre-provider failure or require manual cleanup. This adapter
 * publishes invalidations only from the committed classification result.
 */
export class CapsuleCreateAbandonmentHandler<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> implements CapsuleOperationAbandonmentHandler {
  public readonly operationType = CapsuleOperationType.CREATE

  constructor(private readonly dependencies: CapsuleCreateAbandonmentHandlerDependencies<TDatabase, TTables>) {}

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
    assertCapsuleCreateAbandonmentRelationships(result)

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
