import { and, eq } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  CapsuleRootfsImagePin,
  CapsuleSnapshotAssuranceSchema,
  CapsuleSnapshotMode,
  createCapsuleSnapshotCapturePolicyPin,
  verifyCapsuleBlueprintPin,
  verifyCapsuleSnapshotCapturePolicyPin,
  type CapsuleBlueprintPin,
  type CapsulePersistence,
  type CapsuleSnapshotCapturePolicyPin,
  type CapsuleTables,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { readRootfs, sameRootfs } from '../../shared'
import type { CaptureSourceBranch } from '../types'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

type Transaction<TDatabase extends PostgresJsDatabase> = Parameters<Parameters<TDatabase['transaction']>[0]>[0]

export interface CaptureSourcePins {
  blueprint: CapsuleBlueprintPin
  rootfsImagePin: CapsuleRootfsImagePin
  capturePolicy: CapsuleSnapshotCapturePolicyPin
}

function compareStableString(left: string, right: string): number {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false
  }
  const leftValues = [...left].sort(compareStableString)
  const rightValues = [...right].sort(compareStableString)
  return leftValues.every((value, index) => value === rightValues[index])
}

/**
 * Resolves immutable Snapshot Capture input from the completed operation that
 * materialized the source branch.
 *
 * A root branch derives its historical Blueprint from its completed create
 * operation. A non-root branch derives its Blueprint and capture policy from
 * its completed fork operation.
 *
 * This boundary never consults the mutable Blueprint registry and never
 * discovers provider resources.
 */
export class CaptureSourcePersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly persistence: CapsulePersistence<TDatabase, TTables>) {}

  /**
   * Resolves provenance in an isolated read transaction.
   *
   * Acceptance and failure classification should use `lock()` so provenance is
   * validated inside their existing aggregate transaction.
   */
  public async load(branch: CaptureSourceBranch): Promise<CaptureSourcePins> {
    return await this.persistence.db.transaction(async tx => {
      return await this.lock(tx, branch)
    })
  }

  /**
   * Locks and validates the one operation extension allowed to establish this
   * branch.
   */
  public async lock(tx: Transaction<TDatabase>, branch: CaptureSourceBranch): Promise<CaptureSourcePins> {
    const tables = this.persistence.tables
    const createExtensions = await tx
      .select()
      .from(tables.capsuleCreateOperations)
      .where(eq(tables.capsuleCreateOperations.rootBranchId, branch.id))
      .limit(2)
      .for('update')
    const forkExtensions = await tx
      .select()
      .from(tables.capsuleForkOperations)
      .where(eq(tables.capsuleForkOperations.targetBranchId, branch.id))
      .limit(2)
      .for('update')
    if (branch.isRootBranch) {
      if (createExtensions.length !== 1 || forkExtensions.length !== 0) {
        throw new IncusError(
          'Snapshot Capture root branch does not have exactly one create provenance record.',
          'CONFLICT',
          {
            ownerId: branch.ownerId,
            capsuleId: branch.capsuleId,
            sourceBranchId: branch.id,
            createOperationCount: createExtensions.length,
            forkOperationCount: forkExtensions.length,
          },
        )
      }
      return await this.fromCreate(tx, branch, createExtensions[0]!)
    }
    if (createExtensions.length !== 0 || forkExtensions.length !== 1) {
      throw new IncusError(
        'Snapshot Capture fork branch does not have exactly one fork provenance record.',
        'CONFLICT',
        {
          ownerId: branch.ownerId,
          capsuleId: branch.capsuleId,
          sourceBranchId: branch.id,
          createOperationCount: createExtensions.length,
          forkOperationCount: forkExtensions.length,
        },
      )
    }
    return await this.fromFork(tx, branch, forkExtensions[0]!)
  }

  private async fromCreate(
    tx: Transaction<TDatabase>,
    branch: CaptureSourceBranch,
    extension: TTables['capsuleCreateOperations']['$inferSelect'],
  ): Promise<CaptureSourcePins> {
    const operation = await this.operation(tx, extension.operationId)
    if (
      operation.type !== CapsuleOperationType.CREATE ||
      operation.status !== CapsuleOperationStatus.COMPLETED ||
      operation.completedAt === null ||
      operation.ownerId !== branch.ownerId ||
      operation.capsuleId !== branch.capsuleId ||
      extension.rootBranchId !== branch.id ||
      extension.rootBranchName !== branch.name ||
      extension.blueprintName !== branch.blueprintName ||
      extension.blueprintDigest !== branch.blueprintDigest ||
      extension.cpu !== branch.cpu ||
      extension.memory !== branch.memory
    ) {
      throw new IncusError(
        'Snapshot Capture source branch does not match its completed create operation.',
        'CONFLICT',
        {
          ownerId: branch.ownerId,
          capsuleId: branch.capsuleId,
          sourceBranchId: branch.id,
          createOperationId: extension.operationId,
          operationType: operation.type,
          operationStatus: operation.status,
        },
      )
    }
    const blueprint = verifyCapsuleBlueprintPin({
      name: extension.blueprintName,
      digest: extension.blueprintDigest,
      blueprint: extension.blueprintSnapshot,
    })
    const rootfsImagePin = readRootfs(extension.rootfsImagePin, blueprint.blueprint.image_alias, {
      ownerId: branch.ownerId,
      capsuleId: branch.capsuleId,
      sourceBranchId: branch.id,
      createOperationId: extension.operationId,
    })
    const capturePolicy = createCapsuleSnapshotCapturePolicyPin(blueprint)
    return {
      blueprint,
      rootfsImagePin,
      capturePolicy,
    }
  }

  private async fromFork(
    tx: Transaction<TDatabase>,
    branch: CaptureSourceBranch,
    extension: TTables['capsuleForkOperations']['$inferSelect'],
  ): Promise<CaptureSourcePins> {
    const operation = await this.operation(tx, extension.operationId)
    if (
      operation.type !== CapsuleOperationType.FORK ||
      operation.status !== CapsuleOperationStatus.COMPLETED ||
      operation.completedAt === null ||
      operation.ownerId !== branch.ownerId ||
      operation.capsuleId !== branch.capsuleId ||
      extension.targetBranchId !== branch.id ||
      extension.targetBranchName !== branch.name ||
      extension.targetBranchResourceInventoryDigest !== branch.resourceInventoryDigest ||
      extension.blueprintName !== branch.blueprintName ||
      extension.blueprintDigest !== branch.blueprintDigest ||
      extension.cpu !== branch.cpu ||
      extension.memory !== branch.memory
    ) {
      throw new IncusError('Snapshot Capture source branch does not match its completed fork operation.', 'CONFLICT', {
        ownerId: branch.ownerId,
        capsuleId: branch.capsuleId,
        sourceBranchId: branch.id,
        forkOperationId: extension.operationId,
        sourceSnapshotId: extension.sourceSnapshotId,
        operationType: operation.type,
        operationStatus: operation.status,
      })
    }
    const blueprint = verifyCapsuleBlueprintPin(extension.blueprintPin)
    const rootfsImagePin = readRootfs(extension.rootfsImagePin, blueprint.blueprint.image_alias, {
      ownerId: branch.ownerId,
      capsuleId: branch.capsuleId,
      sourceBranchId: branch.id,
      forkOperationId: extension.operationId,
      sourceSnapshotId: extension.sourceSnapshotId,
    })
    const capturePolicy = verifyCapsuleSnapshotCapturePolicyPin(extension.capturePolicyPin)
    if (
      blueprint.blueprint.schema_version !== extension.blueprintSchemaVersion ||
      blueprint.name !== extension.blueprintName ||
      blueprint.digest !== extension.blueprintDigest ||
      capturePolicy.schemaVersion !== extension.capturePolicySchemaVersion ||
      capturePolicy.digest !== extension.capturePolicyDigest ||
      capturePolicy.blueprintName !== blueprint.name ||
      capturePolicy.blueprintDigest !== blueprint.digest
    ) {
      throw new IncusError('Snapshot Capture fork provenance contains contradictory immutable pins.', 'CONFLICT', {
        ownerId: branch.ownerId,
        capsuleId: branch.capsuleId,
        sourceBranchId: branch.id,
        forkOperationId: extension.operationId,
        sourceSnapshotId: extension.sourceSnapshotId,
      })
    }
    const assurance = CapsuleSnapshotAssuranceSchema.parse({
      mode: extension.sourceSnapshotMode,
      limitations: extension.sourceSnapshotLimitations,
    })
    if (assurance.mode !== CapsuleSnapshotMode.EXPERIMENTAL) {
      throw new IncusError('Snapshot Capture fork provenance uses an unsupported source assurance mode.', 'CONFLICT', {
        ownerId: branch.ownerId,
        capsuleId: branch.capsuleId,
        sourceBranchId: branch.id,
        forkOperationId: extension.operationId,
        sourceSnapshotId: extension.sourceSnapshotId,
        sourceSnapshotMode: assurance.mode,
      })
    }
    const snapshot = await this.snapshot(tx, branch.capsuleId, extension.sourceSnapshotId)
    const snapshotBlueprint = verifyCapsuleBlueprintPin(snapshot.blueprintPin)
    const snapshotRootfsImagePin = readRootfs(snapshot.rootfsImagePin, snapshotBlueprint.blueprint.image_alias, {
      ownerId: branch.ownerId,
      capsuleId: branch.capsuleId,
      sourceBranchId: branch.id,
      forkOperationId: extension.operationId,
      sourceSnapshotId: extension.sourceSnapshotId,
    })
    const snapshotPolicy = verifyCapsuleSnapshotCapturePolicyPin(snapshot.capturePolicyPin)
    const snapshotAssurance = CapsuleSnapshotAssuranceSchema.parse({
      mode: snapshot.mode,
      limitations: snapshot.limitations,
    })
    if (
      snapshotBlueprint.blueprint.schema_version !== snapshot.blueprintSchemaVersion ||
      snapshotBlueprint.name !== snapshot.blueprintName ||
      snapshotBlueprint.digest !== snapshot.blueprintDigest ||
      snapshotPolicy.schemaVersion !== snapshot.capturePolicySchemaVersion ||
      snapshotPolicy.digest !== snapshot.capturePolicyDigest ||
      snapshotPolicy.blueprintName !== snapshotBlueprint.name ||
      snapshotPolicy.blueprintDigest !== snapshotBlueprint.digest ||
      snapshotBlueprint.name !== blueprint.name ||
      snapshotBlueprint.digest !== blueprint.digest ||
      !sameRootfs(snapshotRootfsImagePin, rootfsImagePin) ||
      snapshotPolicy.digest !== capturePolicy.digest ||
      snapshotAssurance.mode !== assurance.mode ||
      !sameStrings(snapshotAssurance.limitations, assurance.limitations)
    ) {
      throw new IncusError(
        'Snapshot Capture fork provenance disagrees with its immutable source snapshot.',
        'CONFLICT',
        {
          ownerId: branch.ownerId,
          capsuleId: branch.capsuleId,
          sourceBranchId: branch.id,
          forkOperationId: extension.operationId,
          sourceSnapshotId: extension.sourceSnapshotId,
        },
      )
    }
    return {
      blueprint,
      rootfsImagePin,
      capturePolicy,
    }
  }

  private async operation(tx: Transaction<TDatabase>, operationId: string) {
    const operations = this.persistence.tables.capsuleOperations
    const [operation] = await tx.select().from(operations).where(eq(operations.id, operationId)).for('update').limit(1)
    if (!operation) {
      throw new IncusError('Snapshot Capture source operation was not found.', 'NOT_FOUND', {
        operationId,
      })
    }
    return operation
  }

  private async snapshot(tx: Transaction<TDatabase>, capsuleId: string, snapshotId: string) {
    const snapshots = this.persistence.tables.capsuleSnapshots
    const [snapshot] = await tx
      .select()
      .from(snapshots)
      .where(and(eq(snapshots.id, snapshotId), eq(snapshots.capsuleId, capsuleId)))
      .for('update')
      .limit(1)
    if (!snapshot) {
      throw new IncusError('Snapshot Capture fork provenance source snapshot was not found.', 'NOT_FOUND', {
        capsuleId,
        snapshotId,
      })
    }
    return snapshot
  }
}
