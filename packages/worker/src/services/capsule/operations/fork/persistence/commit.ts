import { and, eq, isNotNull } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError } from '../../../../../errors'
import { toCapsuleLifecycleState, toCapsuleOperationTransition } from '../../shared'
import type { ForkTerminal } from '../types'
import type { ForkInputPersistence } from './input'
import type { ForkLocks } from './locks'

/**
 * Atomically completes a fork after the locked target branch resource graph is
 * re-proven against immutable fork input and every planned resource has a
 * positively persisted terminal creation or adoption outcome.
 */
export class ForkCommitPersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly locks: ForkLocks<TDatabase, TTables>,
    private readonly input: ForkInputPersistence<TDatabase, TTables>,
  ) {}

  public async commit(operationId: string): Promise<ForkTerminal> {
    return await this.persistence.db.transaction(async tx => {
      const scope = await this.locks.scope(tx, operationId)
      const { operation, capsule, branch } = scope
      if (
        operation.status !== CapsuleOperationStatus.RUNNING ||
        operation.providerMutationStartedAt === null ||
        !branch
      ) {
        throw new IncusError('Capsule fork operation is not eligible for completion.', 'CONFLICT', {
          operationId,
          operationStatus: operation.status,
          providerIntentCommitted: operation.providerMutationStartedAt !== null,
        })
      }

      await this.input.prove(tx, scope, 'completed')

      const tables = this.persistence.tables
      const now = new Date()
      const [completed] = await tx
        .update(tables.capsuleOperations)
        .set({
          status: CapsuleOperationStatus.COMPLETED,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(tables.capsuleOperations.id, operation.id),
            eq(tables.capsuleOperations.type, CapsuleOperationType.FORK),
            eq(tables.capsuleOperations.status, CapsuleOperationStatus.RUNNING),
            isNotNull(tables.capsuleOperations.providerMutationStartedAt),
          ),
        )
        .returning()
      const [offline] = await tx
        .update(tables.capsuleBranches)
        .set({
          status: 'offline',
          runtimeIp: null,
          runtimeErrorCode: null,
          runtimeErrorMessage: null,
          runtimeErrorDetails: null,
          runtimeErrorAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(tables.capsuleBranches.id, branch.id),
            eq(tables.capsuleBranches.ownerId, operation.ownerId),
            eq(tables.capsuleBranches.capsuleId, operation.capsuleId),
            eq(tables.capsuleBranches.isRootBranch, false),
            eq(tables.capsuleBranches.status, 'provisioning'),
          ),
        )
        .returning({
          id: tables.capsuleBranches.id,
          capsuleId: tables.capsuleBranches.capsuleId,
          name: tables.capsuleBranches.name,
          status: tables.capsuleBranches.status,
        })
      if (!completed || !offline) {
        throw new IncusError('Failed to atomically complete the capsule fork.', 'CONFLICT', {
          operationId,
          branchId: branch.id,
        })
      }
      return {
        operation: toCapsuleOperationTransition({
          ownerId: completed.ownerId,
          operationId: completed.id,
          operationType: CapsuleOperationType.FORK,
          operationStatus: completed.status,
          capsuleId: completed.capsuleId,
        }),
        capsule: toCapsuleLifecycleState({
          capsuleId: capsule.id,
          lifecycleStatus: capsule.lifecycleStatus,
          archivedAt: capsule.archivedAt,
          destroyedAt: capsule.destroyedAt,
        }),
        branch: offline,
      }
    })
  }
}
