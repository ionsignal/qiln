import { and, asc, eq } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  CapsuleSnapshotMode,
  verifyCapsuleBlueprintPin,
  verifyCapsuleSnapshotCapturePolicyPin,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { CapsuleOperationReader } from '../../shared'
import type { CapsuleBranchResourceInventoryRow } from '../../../resource'
import type { CapturePlanner } from '../plan'
import type { CaptureExecutionInput, CaptureResourceRecord, CaptureSourceBranch } from '../types'

/**
 * Reloads immutable Snapshot Capture execution input exclusively from
 * PostgreSQL.
 *
 * This boundary performs no registry access, provider discovery, dependency
 * resolution, collection, scheduling, or mutation.
 */
export class CaptureInputPersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly reader: CapsuleOperationReader<TDatabase, TTables>,
    private readonly planner: CapturePlanner,
  ) {}

  public async load(operationId: string): Promise<CaptureExecutionInput> {
    const db = this.persistence.db
    const captureOperations = this.persistence.tables.capsuleSnapshotCaptureOperations
    const capsules = this.persistence.tables.capsules
    const operation = await this.reader.loadById(operationId)
    if (!operation) {
      throw new IncusError('Snapshot Capture operation was not found.', 'NOT_FOUND', {
        operationId,
      })
    }
    if (operation.type !== CapsuleOperationType.SNAPSHOT_CAPTURE) {
      throw new IncusError('Operation is not a Snapshot Capture operation.', 'CONFLICT', {
        operationId,
        operationType: operation.type,
      })
    }
    if (operation.status !== CapsuleOperationStatus.ACCEPTED || operation.providerMutationStartedAt !== null) {
      throw new IncusError('Snapshot Capture operation is not eligible for pre-provider execution.', 'CONFLICT', {
        operationId,
        operationStatus: operation.status,
        providerMutationStartedAt: operation.providerMutationStartedAt?.toISOString() ?? null,
      })
    }
    const [extension] = await db
      .select()
      .from(captureOperations)
      .where(eq(captureOperations.operationId, operationId))
      .limit(1)
    if (!extension || extension.snapshotId !== null) {
      throw new IncusError(
        'Snapshot Capture operation extension is missing or already linked to committed history.',
        'CONFLICT',
        {
          operationId,
          snapshotId: extension?.snapshotId ?? null,
        },
      )
    }
    if (extension.requestedMode !== CapsuleSnapshotMode.EXPERIMENTAL) {
      throw new IncusError('Snapshot Capture operation requested an unsupported evidence mode.', 'CONFLICT', {
        operationId,
        requestedMode: extension.requestedMode,
      })
    }
    const blueprint = verifyCapsuleBlueprintPin(extension.blueprintPin)
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
      throw new IncusError('Snapshot Capture operation pin evidence is internally inconsistent.', 'CONFLICT', {
        operationId,
        blueprintDigest: extension.blueprintDigest,
        capturePolicyDigest: extension.capturePolicyDigest,
      })
    }
    const [capsule] = await db
      .select({
        lifecycleStatus: capsules.lifecycleStatus,
        archivedAt: capsules.archivedAt,
      })
      .from(capsules)
      .where(and(eq(capsules.id, operation.capsuleId), eq(capsules.ownerId, operation.ownerId)))
      .limit(1)
    if (!capsule || capsule.lifecycleStatus !== 'active' || capsule.archivedAt !== null) {
      throw new IncusError('Snapshot Capture capsule is no longer active and unarchived.', 'CONFLICT', {
        operationId,
        capsuleId: operation.capsuleId,
        lifecycleStatus: capsule?.lifecycleStatus ?? null,
        archived: capsule ? capsule.archivedAt !== null : null,
      })
    }
    const branch = await this.branch(operation.ownerId, operation.capsuleId, extension.sourceBranchId)
    if (
      branch.status !== 'capturing' ||
      !branch.isRootBranch ||
      branch.name !== extension.sourceBranchName ||
      branch.resourceInventoryDigest !== extension.sourceBranchResourceInventoryDigest ||
      branch.blueprintName !== blueprint.name ||
      branch.blueprintDigest !== blueprint.digest
    ) {
      throw new IncusError('Snapshot Capture source branch no longer matches its accepted capture fence.', 'CONFLICT', {
        operationId,
        capsuleId: operation.capsuleId,
        sourceBranchId: extension.sourceBranchId,
        sourceBranchStatus: branch.status,
        sourceBranchName: branch.name,
        expectedSourceBranchName: extension.sourceBranchName,
        sourceBranchInventoryDigest: branch.resourceInventoryDigest,
        expectedInventoryDigest: extension.sourceBranchResourceInventoryDigest,
        sourceBranchBlueprintName: branch.blueprintName,
        expectedBlueprintName: blueprint.name,
        sourceBranchBlueprintDigest: branch.blueprintDigest,
        expectedBlueprintDigest: blueprint.digest,
        isRootBranch: branch.isRootBranch,
      })
    }
    const inventory = await this.inventory(branch.id)
    const plan = this.planner.create(
      operationId,
      operation.ownerId,
      operation.capsuleId,
      branch,
      capturePolicy,
      inventory,
    )
    const captureResources = await this.resources(operationId)
    this.planner.assertResources(operationId, plan, captureResources)
    return {
      operationId,
      ownerId: operation.ownerId,
      capsuleId: operation.capsuleId,
      sourceBranchId: extension.sourceBranchId,
      sourceBranchName: extension.sourceBranchName,
      sourceBranchResourceInventoryDigest: extension.sourceBranchResourceInventoryDigest,
      blueprint,
      requestedMode: extension.requestedMode,
      capturePolicy,
      plan,
    }
  }

  private async branch(ownerId: string, capsuleId: string, branchId: string): Promise<CaptureSourceBranch> {
    const db = this.persistence.db
    const branches = this.persistence.tables.capsuleBranches
    const [branch] = await db
      .select({
        id: branches.id,
        ownerId: branches.ownerId,
        capsuleId: branches.capsuleId,
        name: branches.name,
        status: branches.status,
        isRootBranch: branches.isRootBranch,
        blueprintName: branches.blueprintName,
        blueprintDigest: branches.blueprintDigest,
        cpu: branches.cpu,
        memory: branches.memory,
        resourceInventoryDigest: branches.resourceInventoryDigest,
      })
      .from(branches)
      .where(and(eq(branches.id, branchId), eq(branches.ownerId, ownerId), eq(branches.capsuleId, capsuleId)))
      .limit(1)
    if (!branch) {
      throw new IncusError('Snapshot Capture source branch was not found.', 'NOT_FOUND', {
        ownerId,
        capsuleId,
        sourceBranchId: branchId,
      })
    }
    return branch
  }

  private async inventory(branchId: string): Promise<CapsuleBranchResourceInventoryRow[]> {
    const db = this.persistence.db
    const resources = this.persistence.tables.capsuleBranchResources
    return await db
      .select({
        id: resources.id,
        ownerId: resources.ownerId,
        branchId: resources.branchId,
        branchName: resources.branchName,
        provider: resources.provider,
        resourceType: resources.resourceType,
        resourceKey: resources.resourceKey,
        blueprintVolumeName: resources.blueprintVolumeName,
        status: resources.status,
        cleanupPolicy: resources.cleanupPolicy,
        metadata: resources.metadata,
        createdByOperationId: resources.createdByOperationId,
        lastOperationId: resources.lastOperationId,
      })
      .from(resources)
      .where(eq(resources.branchId, branchId))
      .orderBy(asc(resources.createdAt), asc(resources.id))
  }

  private async resources(operationId: string): Promise<CaptureResourceRecord[]> {
    const db = this.persistence.db
    const resources = this.persistence.tables.capsuleSnapshotCaptureResources
    return await db
      .select({
        id: resources.id,
        operationId: resources.operationId,
        sourceBranchResourceId: resources.sourceBranchResourceId,
        artifactRootId: resources.artifactRootId,
        blueprintVolumeName: resources.blueprintVolumeName,
        provider: resources.provider,
        kind: resources.kind,
        project: resources.project,
        pool: resources.pool,
        sourceVolume: resources.sourceVolume,
        snapshotName: resources.snapshotName,
        status: resources.status,
        snapshotIntentAt: resources.snapshotIntentAt,
        snapshotCreatedAt: resources.snapshotCreatedAt,
        cleanupIntentAt: resources.cleanupIntentAt,
        cleanupCompletedAt: resources.cleanupCompletedAt,
        failureCode: resources.failureCode,
        failureMessage: resources.failureMessage,
        failureDetails: resources.failureDetails,
        failureAt: resources.failureAt,
      })
      .from(resources)
      .where(eq(resources.operationId, operationId))
      .orderBy(asc(resources.artifactRootId), asc(resources.id))
  }
}
