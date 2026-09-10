import { and, eq } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  verifyCapsuleBlueprintPin,
  type CapsuleBlueprintPin,
  type CapsuleBranchName,
  type CapsuleBranchResourceInventoryDigest,
  type CapsulePersistence,
  type CapsuleRootfsImagePin,
  type CapsuleTables,
} from '@qiln/core/server'
import { IncusError } from '../../../errors'
import { readRootfs, sameRootfs } from '../operations/shared/rootfs'
import { CapsuleSnapshotStore } from '../snapshot/store'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

type Transaction<TDatabase extends PostgresJsDatabase> = Parameters<Parameters<TDatabase['transaction']>[0]>[0]

export interface CapsuleBranchProvenanceBranch {
  id: string
  ownerId: string
  capsuleId: string
  name: CapsuleBranchName
  isRootBranch: boolean
  blueprintName: string
  blueprintDigest: string
  cpu: string
  memory: string
  resourceInventoryDigest: CapsuleBranchResourceInventoryDigest | null
}

export interface CapsuleBranchProvenancePins {
  operationId: string
  blueprint: CapsuleBlueprintPin
  rootfsImagePin: CapsuleRootfsImagePin
}

/**
 * Resolves branch reconstruction evidence without consulting mutable catalogs
 * or provider state.
 *
 * The originating operation identity also lets mutation callers independently
 * verify resource creation provenance.
 */
export class CapsuleBranchProvenance<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  private readonly snapshots: CapsuleSnapshotStore<TDatabase, TTables>

  constructor(private readonly persistence: CapsulePersistence<TDatabase, TTables>) {
    this.snapshots = new CapsuleSnapshotStore(persistence)
  }

  public async load(branch: CapsuleBranchProvenanceBranch): Promise<CapsuleBranchProvenancePins> {
    return await this.persistence.db.transaction(async tx => {
      return await this.lock(tx, branch)
    })
  }

  public async lock(
    tx: Transaction<TDatabase>,
    branch: CapsuleBranchProvenanceBranch,
  ): Promise<CapsuleBranchProvenancePins> {
    const current = await this.lockBranch(tx, branch)
    const tables = this.persistence.tables
    const creates = await tx
      .select()
      .from(tables.capsuleCreateOperations)
      .where(eq(tables.capsuleCreateOperations.rootBranchId, current.id))
      .limit(2)
      .for('update')
    const forks = await tx
      .select()
      .from(tables.capsuleForkOperations)
      .where(eq(tables.capsuleForkOperations.targetBranchId, current.id))
      .limit(2)
      .for('update')
    if (current.isRootBranch) {
      if (creates.length !== 1 || forks.length !== 0) {
        throw new IncusError('Root branch does not have exactly one create provenance record.', 'CONFLICT', {
          branchId: current.id,
        })
      }
      return await this.fromCreate(tx, current, creates[0]!)
    }
    if (creates.length !== 0 || forks.length !== 1) {
      throw new IncusError('Forked branch does not have exactly one fork provenance record.', 'CONFLICT', {
        branchId: current.id,
      })
    }
    return await this.fromFork(tx, current, forks[0]!)
  }

  /**
   * Serializes standalone and transaction-local provenance reads through the
   * capsule before locking branch or originating-operation evidence.
   *
   * The supplied branch is a candidate, not locking authority. Its identity and
   * reconstruction fields must still match after acquiring the parent lock.
   * Runtime and lifecycle eligibility remain the caller's responsibility.
   */
  private async lockBranch(
    tx: Transaction<TDatabase>,
    branch: CapsuleBranchProvenanceBranch,
  ): Promise<CapsuleBranchProvenanceBranch> {
    const { capsules, capsuleBranches } = this.persistence.tables
    const [capsule] = await tx
      .select({
        id: capsules.id,
      })
      .from(capsules)
      .where(and(eq(capsules.id, branch.capsuleId), eq(capsules.ownerId, branch.ownerId)))
      .for('update')
      .limit(1)
    if (!capsule) {
      throw new IncusError('Capsule not found or access denied while resolving branch provenance.', 'NOT_FOUND', {
        capsuleId: branch.capsuleId,
      })
    }
    const [current] = await tx
      .select()
      .from(capsuleBranches)
      .where(
        and(
          eq(capsuleBranches.id, branch.id),
          eq(capsuleBranches.ownerId, branch.ownerId),
          eq(capsuleBranches.capsuleId, capsule.id),
        ),
      )
      .for('update')
      .limit(1)
    if (!current) {
      throw new IncusError('Capsule branch not found or access denied while resolving provenance.', 'NOT_FOUND', {
        capsuleId: branch.capsuleId,
        branchId: branch.id,
      })
    }
    if (
      current.name !== branch.name ||
      current.isRootBranch !== branch.isRootBranch ||
      current.blueprintName !== branch.blueprintName ||
      current.blueprintDigest !== branch.blueprintDigest ||
      current.cpu !== branch.cpu ||
      current.memory !== branch.memory ||
      current.resourceInventoryDigest !== branch.resourceInventoryDigest
    ) {
      throw new IncusError('Branch provenance candidate changed while acquiring its parent locks.', 'CONFLICT', {
        capsuleId: branch.capsuleId,
        branchId: branch.id,
      })
    }
    return current
  }

  private async fromCreate(
    tx: Transaction<TDatabase>,
    branch: CapsuleBranchProvenanceBranch,
    extension: CapsuleTables['capsuleCreateOperations']['$inferSelect'],
  ): Promise<CapsuleBranchProvenancePins> {
    await this.assertOperation(tx, extension.operationId, 'create', branch)
    if (
      extension.rootBranchId !== branch.id ||
      extension.rootBranchName !== branch.name ||
      extension.blueprintName !== branch.blueprintName ||
      extension.blueprintDigest !== branch.blueprintDigest ||
      extension.cpu !== branch.cpu ||
      extension.memory !== branch.memory
    ) {
      throw new IncusError('Branch does not match its completed create operation.', 'CONFLICT', {
        branchId: branch.id,
        operationId: extension.operationId,
      })
    }
    const blueprint = verifyCapsuleBlueprintPin({
      name: extension.blueprintName,
      digest: extension.blueprintDigest,
      blueprint: extension.blueprintSnapshot,
    })
    return {
      operationId: extension.operationId,
      blueprint,
      rootfsImagePin: readRootfs(extension.rootfsImagePin, blueprint.blueprint.image_alias, {
        branchId: branch.id,
        operationId: extension.operationId,
      }),
    }
  }

  private async fromFork(
    tx: Transaction<TDatabase>,
    branch: CapsuleBranchProvenanceBranch,
    extension: CapsuleTables['capsuleForkOperations']['$inferSelect'],
  ): Promise<CapsuleBranchProvenancePins> {
    await this.assertOperation(tx, extension.operationId, 'fork', branch)
    const blueprint = verifyCapsuleBlueprintPin(extension.blueprintPin)
    const rootfsImagePin = readRootfs(extension.rootfsImagePin, blueprint.blueprint.image_alias, {
      branchId: branch.id,
      operationId: extension.operationId,
    })
    if (
      extension.targetBranchId !== branch.id ||
      extension.targetBranchName !== branch.name ||
      extension.targetBranchResourceInventoryDigest !== branch.resourceInventoryDigest ||
      extension.blueprintSchemaVersion !== blueprint.blueprint.schema_version ||
      extension.blueprintName !== blueprint.name ||
      extension.blueprintDigest !== blueprint.digest ||
      branch.blueprintName !== blueprint.name ||
      branch.blueprintDigest !== blueprint.digest ||
      extension.cpu !== branch.cpu ||
      extension.memory !== branch.memory
    ) {
      throw new IncusError('Branch does not match its completed fork operation.', 'CONFLICT', {
        branchId: branch.id,
        operationId: extension.operationId,
      })
    }
    const snapshot = await this.snapshots.read(tx, branch.ownerId, branch.capsuleId, extension.sourceSnapshotId)
    if (
      snapshot.blueprintName !== blueprint.name ||
      snapshot.blueprintDigest !== blueprint.digest ||
      !sameRootfs(snapshot.rootfsImagePin, rootfsImagePin)
    ) {
      throw new IncusError('Fork provenance disagrees with its committed source snapshot.', 'CONFLICT', {
        branchId: branch.id,
        operationId: extension.operationId,
        snapshotId: snapshot.id,
      })
    }
    return {
      operationId: extension.operationId,
      blueprint,
      rootfsImagePin,
    }
  }

  private async assertOperation(
    tx: Transaction<TDatabase>,
    operationId: string,
    type: typeof CapsuleOperationType.CREATE | typeof CapsuleOperationType.FORK,
    branch: CapsuleBranchProvenanceBranch,
  ): Promise<void> {
    const operations = this.persistence.tables.capsuleOperations
    const [operation] = await tx
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.id, operationId),
          eq(operations.ownerId, branch.ownerId),
          eq(operations.capsuleId, branch.capsuleId),
        ),
      )
      .for('update')
      .limit(1)
    if (
      !operation ||
      operation.type !== type ||
      operation.status !== CapsuleOperationStatus.COMPLETED ||
      operation.completedAt === null ||
      operation.ownerId !== branch.ownerId ||
      operation.capsuleId !== branch.capsuleId ||
      operation.failedAt !== null ||
      operation.failureCode !== null ||
      operation.failureMessage !== null ||
      operation.failureDetails !== null
    ) {
      throw new IncusError('Branch provenance does not resolve a completed owned operation.', 'CONFLICT', {
        branchId: branch.id,
        operationId,
        expectedType: type,
      })
    }
  }
}
