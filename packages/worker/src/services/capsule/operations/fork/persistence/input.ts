import { and, asc, eq } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError } from '../../../../../errors'
import type { ForkPlanner } from '../plan'
import type { ForkExecution } from '../types'
import { assertForkEvidence, ForkSourcePersistence } from './source'

/**
 * Reloads immutable fork execution input exclusively from PostgreSQL.
 *
 * The complete source snapshot graph and target resource inventory are locked
 * and revalidated before execution may claim the operation.
 */
export class ForkInputPersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly planner: ForkPlanner,
    private readonly sources: ForkSourcePersistence<TDatabase, TTables>,
  ) {}

  public async load(operationId: string): Promise<ForkExecution> {
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
      if (!operation) {
        throw new IncusError('Capsule fork operation was not found.', 'NOT_FOUND', {
          operationId,
        })
      }
      if (operation.status !== CapsuleOperationStatus.ACCEPTED || operation.providerMutationStartedAt !== null) {
        throw new IncusError('Capsule fork operation is not eligible for execution.', 'CONFLICT', {
          operationId,
          operationStatus: operation.status,
          providerMutationStartedAt: operation.providerMutationStartedAt?.toISOString() ?? null,
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
      if (!capsule || capsule.lifecycleStatus !== 'active' || capsule.archivedAt !== null) {
        throw new IncusError('Capsule fork aggregate is no longer active and unarchived.', 'CONFLICT', {
          operationId,
          capsuleId: operation.capsuleId,
          lifecycleStatus: capsule?.lifecycleStatus ?? null,
          archived: capsule ? capsule.archivedAt !== null : null,
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
      if (branch.status !== 'provisioning') {
        throw new IncusError('Capsule fork target branch is not in its provisioning state.', 'CONFLICT', {
          operationId,
          branchId: branch.id,
          branchStatus: branch.status,
        })
      }

      assertForkEvidence(operation, extension, source, branch)

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
        .select({
          id: tables.capsuleBranchResources.id,
          ownerId: tables.capsuleBranchResources.ownerId,
          branchId: tables.capsuleBranchResources.branchId,
          branchName: tables.capsuleBranchResources.branchName,
          createdByOperationId: tables.capsuleBranchResources.createdByOperationId,
          lastOperationId: tables.capsuleBranchResources.lastOperationId,
          resourceType: tables.capsuleBranchResources.resourceType,
          provider: tables.capsuleBranchResources.provider,
          resourceKey: tables.capsuleBranchResources.resourceKey,
          blueprintVolumeName: tables.capsuleBranchResources.blueprintVolumeName,
          status: tables.capsuleBranchResources.status,
          cleanupPolicy: tables.capsuleBranchResources.cleanupPolicy,
          metadata: tables.capsuleBranchResources.metadata,
          failureCode: tables.capsuleBranchResources.failureCode,
          failureMessage: tables.capsuleBranchResources.failureMessage,
          failureDetails: tables.capsuleBranchResources.failureDetails,
        })
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
        stage: 'accepted',
        plan,
        resources,
      })

      return {
        operationId: operation.id,
        ownerId: operation.ownerId,
        capsuleId: operation.capsuleId,
        sourceSnapshotId: extension.sourceSnapshotId,
        branchId: branch.id,
        branchName: extension.targetBranchName,
        cpu: extension.cpu,
        memory: extension.memory,
        blueprint: source.blueprint,
        capturePolicy: source.capturePolicy,
        sourceMode: source.mode,
        sourceLimitations: source.limitations,
        inventoryDigest: extension.targetBranchResourceInventoryDigest,
        plan,
        resources,
      }
    })
  }
}
