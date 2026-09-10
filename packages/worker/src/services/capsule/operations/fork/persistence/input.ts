import { CapsuleOperationStatus, type CapsulePersistence, type CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError } from '../../../../../errors'
import type { ForkPlanner } from '../plan'
import type { ForkExecution, ForkResourceProofStage } from '../types'
import { assertForkEvidence, assertForkLedger, ForkSourcePersistence } from './source'
import type { ForkLocks, ForkScope, ForkTransaction } from './locks'

/**
 * Reloads immutable fork execution input exclusively from PostgreSQL.
 *
 * The capsule parent lock serializes the committed source read and complete
 * target accounting proof with retained capsule mutations and replay paths.
 */
export class ForkInputPersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly planner: ForkPlanner,
    private readonly sources: ForkSourcePersistence<TDatabase, TTables>,
    private readonly locks: ForkLocks<TDatabase, TTables>,
  ) {}

  public async load(operationId: string): Promise<ForkExecution> {
    return await this.persistence.db.transaction(async tx => {
      const scope = await this.locks.scope(tx, operationId)
      if (scope.operation.status !== CapsuleOperationStatus.ACCEPTED) {
        throw new IncusError('Capsule fork operation is not eligible for execution.', 'CONFLICT', {
          operationId,
          operationStatus: scope.operation.status,
        })
      }
      return await this.prove(tx, scope, 'accepted')
    })
  }

  /**
   * Live compensation reloads the same immutable plan and complete accounting.
   *
   * This method is not used by startup abandonment and does not authorize a
   * replacement executor.
   */
  public async compensation(operationId: string): Promise<ForkExecution> {
    return await this.persistence.db.transaction(async tx => {
      const scope = await this.locks.scope(tx, operationId)
      if (
        scope.operation.status !== CapsuleOperationStatus.RUNNING ||
        scope.operation.providerMutationStartedAt === null
      ) {
        throw new IncusError('Capsule fork is not eligible for live compensation.', 'CONFLICT', {
          operationId,
          operationStatus: scope.operation.status,
        })
      }
      return await this.prove(tx, scope, 'compensating')
    })
  }

  public async prove(
    tx: ForkTransaction<TDatabase>,
    scope: ForkScope,
    stage: ForkResourceProofStage,
  ): Promise<ForkExecution> {
    const { operation, capsule, extension, branch } = scope
    assertForkLedger(operation)
    if (!extension || !branch) {
      throw new IncusError('Capsule fork is missing its immutable input or owned target branch.', 'CONFLICT', {
        operationId: operation.id,
        extensionPresent: extension !== null,
        branchPresent: branch !== null,
      })
    }
    if (capsule.lifecycleStatus !== 'active' || capsule.archivedAt !== null || branch.status !== 'provisioning') {
      throw new IncusError('Capsule fork aggregate is not eligible for this execution boundary.', 'CONFLICT', {
        operationId: operation.id,
        lifecycleStatus: capsule.lifecycleStatus,
        archived: capsule.archivedAt !== null,
        branchId: branch.id,
        branchStatus: branch.status,
      })
    }
    const source = await this.sources.read(tx, operation.ownerId, operation.capsuleId, extension.sourceSnapshotId)

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
    const resources = await this.locks.resources(tx, operation.id, branch.id)

    this.planner.assertResources({
      operationId: operation.id,
      ownerId: operation.ownerId,
      branchId: branch.id,
      branchName: branch.name,
      extensionInventoryDigest: extension.targetBranchResourceInventoryDigest,
      branchInventoryDigest: branch.resourceInventoryDigest,
      stage,
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
      inventoryDigest: extension.targetBranchResourceInventoryDigest,
      plan,
      resources,
    }
  }
}
