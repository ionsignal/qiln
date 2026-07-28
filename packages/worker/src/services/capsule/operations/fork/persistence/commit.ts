import { and, asc, eq, isNotNull } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError } from '../../../../../errors'
import { toCapsuleLifecycleState, toCapsuleOperationTransition } from '../../shared'
import type { ForkPlanner } from '../plan'
import type { ForkTerminal } from '../types'
import { assertForkEvidence, ForkSourcePersistence } from './source'

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
    private readonly planner: ForkPlanner,
    private readonly sources: ForkSourcePersistence<TDatabase, TTables>,
  ) {}

  public async commit(operationId: string): Promise<ForkTerminal> {
    return await this.persistence.db.transaction(async tx => {
      const tables = this.persistence.tables
      const [operation] = await tx
        .select()
        .from(tables.capsuleOperations)
        .where(
          and(
            eq(tables.capsuleOperations.id, operationId),
            eq(tables.capsuleOperations.type, CapsuleOperationType.FORK),
          ),
        )
        .for('update')
        .limit(1)
      if (
        !operation ||
        operation.status !== CapsuleOperationStatus.RUNNING ||
        operation.providerMutationStartedAt === null
      ) {
        throw new IncusError('Capsule fork operation is not eligible for completion.', 'CONFLICT', {
          operationId,
          operationStatus: operation?.status ?? null,
          providerIntentCommitted: operation?.providerMutationStartedAt !== null,
        })
      }
      const [extension] = await tx
        .select()
        .from(tables.capsuleForkOperations)
        .where(eq(tables.capsuleForkOperations.operationId, operation.id))
        .for('update')
        .limit(1)
      if (!extension) {
        throw new IncusError('Capsule fork operation is missing immutable input.', 'CONFLICT', {
          operationId,
        })
      }
      const [capsule] = await tx
        .select()
        .from(tables.capsules)
        .where(and(eq(tables.capsules.id, operation.capsuleId), eq(tables.capsules.ownerId, operation.ownerId)))
        .for('update')
        .limit(1)
      if (!capsule) {
        throw new IncusError('Capsule fork aggregate was not found.', 'NOT_FOUND', {
          operationId,
          capsuleId: operation.capsuleId,
        })
      }
      const source = await this.sources.lock(tx, operation.ownerId, operation.capsuleId, extension.sourceSnapshotId)
      const [branch] = await tx
        .select()
        .from(tables.capsuleBranches)
        .where(
          and(
            eq(tables.capsuleBranches.id, extension.targetBranchId),
            eq(tables.capsuleBranches.ownerId, operation.ownerId),
            eq(tables.capsuleBranches.capsuleId, operation.capsuleId),
          ),
        )
        .for('update')
        .limit(1)
      if (!branch) {
        throw new IncusError('Capsule fork target branch was not found.', 'NOT_FOUND', {
          operationId,
          branchId: extension.targetBranchId,
        })
      }

      assertForkEvidence(operation, extension, source, branch)

      if (capsule.lifecycleStatus !== 'active' || capsule.archivedAt !== null || branch.status !== 'provisioning') {
        throw new IncusError('Capsule fork aggregate is not eligible for completion.', 'CONFLICT', {
          operationId,
          lifecycleStatus: capsule.lifecycleStatus,
          archived: capsule.archivedAt !== null,
          branchStatus: branch.status,
        })
      }
      const plan = this.planner.create({
        operationId: operation.id,
        ownerId: operation.ownerId,
        branchId: branch.id,
        branchName: branch.name,
        cpu: extension.cpu,
        memory: extension.memory,
        source,
      })
      const resources = await tx
        .select()
        .from(tables.capsuleBranchResources)
        .where(eq(tables.capsuleBranchResources.branchId, branch.id))
        .orderBy(asc(tables.capsuleBranchResources.createdAt), asc(tables.capsuleBranchResources.id))
        .for('update')

      this.planner.assertResources({
        operationId: operation.id,
        ownerId: operation.ownerId,
        branchId: branch.id,
        branchName: branch.name,
        extensionInventoryDigest: extension.targetBranchResourceInventoryDigest,
        branchInventoryDigest: branch.resourceInventoryDigest,
        stage: 'completed',
        plan,
        resources,
      })

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
        .returning({
          id: tables.capsuleOperations.id,
        })
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
          ownerId: operation.ownerId,
          operationId: operation.id,
          operationType: CapsuleOperationType.FORK,
          operationStatus: CapsuleOperationStatus.COMPLETED,
          capsuleId: operation.capsuleId,
        }),
        capsule: toCapsuleLifecycleState({
          capsuleId: operation.capsuleId,
          lifecycleStatus: capsule.lifecycleStatus,
          archivedAt: capsule.archivedAt,
          destroyedAt: capsule.destroyedAt,
        }),
        branch: offline,
      }
    })
  }
}
