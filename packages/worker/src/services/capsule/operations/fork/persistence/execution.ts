import { and, eq, isNull } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError } from '../../../../../errors'
import { toCapsuleOperationTransition } from '../../shared'
import type { ForkRunning } from '../types'

/**
 * Owns base-ledger execution transitions for one fork operation.
 */
export class ForkExecutionPersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly persistence: CapsulePersistence<TDatabase, TTables>) {}

  public async claim(operationId: string): Promise<ForkRunning> {
    const operations = this.persistence.tables.capsuleOperations
    const now = new Date()
    const [operation] = await this.persistence.db
      .update(operations)
      .set({
        status: CapsuleOperationStatus.RUNNING,
        executionStartedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(operations.id, operationId),
          eq(operations.type, CapsuleOperationType.FORK),
          eq(operations.status, CapsuleOperationStatus.ACCEPTED),
          isNull(operations.providerMutationStartedAt),
        ),
      )
      .returning({
        ownerId: operations.ownerId,
        capsuleId: operations.capsuleId,
        status: operations.status,
      })
    if (!operation) {
      throw new IncusError('Capsule fork operation could not be claimed.', 'CONFLICT', {
        operationId,
      })
    }
    return {
      operation: toCapsuleOperationTransition({
        ownerId: operation.ownerId,
        operationId,
        operationType: CapsuleOperationType.FORK,
        operationStatus: operation.status,
        capsuleId: operation.capsuleId,
      }),
    }
  }

  /**
   * Commits the operation-wide provider-intent fence.
   *
   * This must complete before the first Incus state-changing request.
   */
  public async intent(operationId: string): Promise<void> {
    const operations = this.persistence.tables.capsuleOperations
    const now = new Date()
    const result = await this.persistence.db
      .update(operations)
      .set({
        providerMutationStartedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(operations.id, operationId),
          eq(operations.type, CapsuleOperationType.FORK),
          eq(operations.status, CapsuleOperationStatus.RUNNING),
          isNull(operations.providerMutationStartedAt),
        ),
      )
      .returning({
        id: operations.id,
      })
    if (result.length !== 1) {
      throw new IncusError('Failed to commit the capsule fork provider-intent fence.', 'CONFLICT', {
        operationId,
      })
    }
  }
}
