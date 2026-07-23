import { and, asc, eq } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  CapsuleSnapshotMode,
  capsuleBranchesTable,
  capsuleBranchResourcesTable,
  capsuleSnapshotCaptureOperationsTable,
  capsuleSnapshotCaptureResourcesTable,
  capsulesTable,
  verifyCapsuleSnapshotCapturePolicyPin,
  type CapsuleHostDbContract,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
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
export class CaptureInputPersistence {
  constructor(
    private readonly db: CapsuleHostDbContract,
    private readonly reader: CapsuleOperationReader,
    private readonly planner: CapturePlanner,
  ) {}

  public async load(operationId: string): Promise<CaptureExecutionInput> {
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
    const [extension] = await this.db
      .select()
      .from(capsuleSnapshotCaptureOperationsTable)
      .where(eq(capsuleSnapshotCaptureOperationsTable.operationId, operationId))
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
    const policy = verifyCapsuleSnapshotCapturePolicyPin(extension.capturePolicyPin)
    if (
      policy.schemaVersion !== extension.capturePolicySchemaVersion ||
      policy.digest !== extension.capturePolicyDigest
    ) {
      throw new IncusError('Snapshot Capture operation policy evidence is internally inconsistent.', 'CONFLICT', {
        operationId,
        persistedSchemaVersion: extension.capturePolicySchemaVersion,
        policySchemaVersion: policy.schemaVersion,
        persistedDigest: extension.capturePolicyDigest,
        policyDigest: policy.digest,
      })
    }
    const [capsule] = await this.db
      .select({
        lifecycleStatus: capsulesTable.lifecycleStatus,
        archivedAt: capsulesTable.archivedAt,
      })
      .from(capsulesTable)
      .where(and(eq(capsulesTable.id, operation.capsuleId), eq(capsulesTable.ownerId, operation.ownerId)))
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
      branch.resourceInventoryDigest !== extension.sourceBranchResourceInventoryDigest
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
        isRootBranch: branch.isRootBranch,
      })
    }
    const inventory = await this.inventory(branch.id)
    const plan = this.planner.create(operationId, operation.ownerId, operation.capsuleId, branch, policy, inventory)
    const captureResources = await this.resources(operationId)
    this.planner.assertResources(operationId, plan, captureResources)
    return {
      operationId,
      ownerId: operation.ownerId,
      capsuleId: operation.capsuleId,
      sourceBranchId: extension.sourceBranchId,
      sourceBranchName: extension.sourceBranchName,
      sourceBranchResourceInventoryDigest: extension.sourceBranchResourceInventoryDigest,
      requestedMode: extension.requestedMode,
      capturePolicy: policy,
      plan,
    }
  }

  private async branch(ownerId: string, capsuleId: string, branchId: string): Promise<CaptureSourceBranch> {
    const [branch] = await this.db
      .select({
        id: capsuleBranchesTable.id,
        ownerId: capsuleBranchesTable.ownerId,
        capsuleId: capsuleBranchesTable.capsuleId,
        name: capsuleBranchesTable.name,
        status: capsuleBranchesTable.status,
        isRootBranch: capsuleBranchesTable.isRootBranch,
        blueprintName: capsuleBranchesTable.blueprintName,
        blueprintDigest: capsuleBranchesTable.blueprintDigest,
        cpu: capsuleBranchesTable.cpu,
        memory: capsuleBranchesTable.memory,
        resourceInventoryDigest: capsuleBranchesTable.resourceInventoryDigest,
      })
      .from(capsuleBranchesTable)
      .where(
        and(
          eq(capsuleBranchesTable.id, branchId),
          eq(capsuleBranchesTable.ownerId, ownerId),
          eq(capsuleBranchesTable.capsuleId, capsuleId),
        ),
      )
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
    return await this.db
      .select({
        id: capsuleBranchResourcesTable.id,
        ownerId: capsuleBranchResourcesTable.ownerId,
        branchId: capsuleBranchResourcesTable.branchId,
        branchName: capsuleBranchResourcesTable.branchName,
        provider: capsuleBranchResourcesTable.provider,
        resourceType: capsuleBranchResourcesTable.resourceType,
        resourceKey: capsuleBranchResourcesTable.resourceKey,
        blueprintVolumeName: capsuleBranchResourcesTable.blueprintVolumeName,
        status: capsuleBranchResourcesTable.status,
        cleanupPolicy: capsuleBranchResourcesTable.cleanupPolicy,
        metadata: capsuleBranchResourcesTable.metadata,
        createdByOperationId: capsuleBranchResourcesTable.createdByOperationId,
        lastOperationId: capsuleBranchResourcesTable.lastOperationId,
      })
      .from(capsuleBranchResourcesTable)
      .where(eq(capsuleBranchResourcesTable.branchId, branchId))
      .orderBy(asc(capsuleBranchResourcesTable.createdAt), asc(capsuleBranchResourcesTable.id))
  }

  private async resources(operationId: string): Promise<CaptureResourceRecord[]> {
    return await this.db
      .select({
        id: capsuleSnapshotCaptureResourcesTable.id,
        operationId: capsuleSnapshotCaptureResourcesTable.operationId,
        sourceBranchResourceId: capsuleSnapshotCaptureResourcesTable.sourceBranchResourceId,
        artifactRootId: capsuleSnapshotCaptureResourcesTable.artifactRootId,
        blueprintVolumeName: capsuleSnapshotCaptureResourcesTable.blueprintVolumeName,
        provider: capsuleSnapshotCaptureResourcesTable.provider,
        kind: capsuleSnapshotCaptureResourcesTable.kind,
        project: capsuleSnapshotCaptureResourcesTable.project,
        pool: capsuleSnapshotCaptureResourcesTable.pool,
        sourceVolume: capsuleSnapshotCaptureResourcesTable.sourceVolume,
        snapshotName: capsuleSnapshotCaptureResourcesTable.snapshotName,
        status: capsuleSnapshotCaptureResourcesTable.status,
        snapshotIntentAt: capsuleSnapshotCaptureResourcesTable.snapshotIntentAt,
        snapshotCreatedAt: capsuleSnapshotCaptureResourcesTable.snapshotCreatedAt,
        cleanupIntentAt: capsuleSnapshotCaptureResourcesTable.cleanupIntentAt,
        cleanupCompletedAt: capsuleSnapshotCaptureResourcesTable.cleanupCompletedAt,
        failureCode: capsuleSnapshotCaptureResourcesTable.failureCode,
        failureMessage: capsuleSnapshotCaptureResourcesTable.failureMessage,
        failureDetails: capsuleSnapshotCaptureResourcesTable.failureDetails,
        failureAt: capsuleSnapshotCaptureResourcesTable.failureAt,
      })
      .from(capsuleSnapshotCaptureResourcesTable)
      .where(eq(capsuleSnapshotCaptureResourcesTable.operationId, operationId))
      .orderBy(asc(capsuleSnapshotCaptureResourcesTable.artifactRootId), asc(capsuleSnapshotCaptureResourcesTable.id))
  }
}
