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
import type { ForkInputPersistence } from './input'
import type { ForkLocks } from './locks'

/**
 * Owns base-ledger execution transitions for one fork operation.
 *
 * Claim and provider intent independently prove the immutable input and
 * complete untouched resource plan under the capsule-first lock discipline.
 */
export class ForkExecutionPersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly locks: ForkLocks<TDatabase, TTables>,
    private readonly input: ForkInputPersistence<TDatabase, TTables>,
  ) {}

  public async claim(operationId: string): Promise<ForkRunning> {
    return await this.persistence.db.transaction(async tx => {
      const scope = await this.locks.scope(tx, operationId)
      if (scope.operation.status !== CapsuleOperationStatus.ACCEPTED) {
        throw new IncusError('Capsule fork operation could not be claimed.', 'CONFLICT', {
          operationId,
          operationStatus: scope.operation.status,
        })
      }
      const execution = await this.input.prove(tx, scope, 'accepted')
      const operations = this.persistence.tables.capsuleOperations
      const now = new Date()
      const [operation] = await tx
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
            isNull(operations.executionStartedAt),
            isNull(operations.providerMutationStartedAt),
          ),
        )
        .returning()
      if (!operation) {
        throw new IncusError('Capsule fork operation could not be claimed.', 'CONFLICT', {
          operationId,
        })
      }
      return {
        operation: toCapsuleOperationTransition({
          ownerId: operation.ownerId,
          operationId: operation.id,
          operationType: CapsuleOperationType.FORK,
          operationStatus: operation.status,
          capsuleId: operation.capsuleId,
        }),
        execution,
      }
    })
  }

  /**
   * Commits the operation-wide provider-intent fence.
   *
   * This must complete before the first Incus state-changing request.
   */
  public async intent(operationId: string): Promise<void> {
    await this.persistence.db.transaction(async tx => {
      const scope = await this.locks.scope(tx, operationId)
      if (
        scope.operation.status !== CapsuleOperationStatus.RUNNING ||
        scope.operation.providerMutationStartedAt !== null
      ) {
        throw new IncusError('Capsule fork is not eligible to record provider intent.', 'CONFLICT', {
          operationId,
        })
      }
      await this.input.prove(tx, scope, 'accepted')
      const operations = this.persistence.tables.capsuleOperations
      const now = new Date()
      const [operation] = await tx
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
      if (!operation) {
        throw new IncusError('Failed to commit the capsule fork provider-intent fence.', 'CONFLICT', {
          operationId,
        })
      }
    })
  }
}
