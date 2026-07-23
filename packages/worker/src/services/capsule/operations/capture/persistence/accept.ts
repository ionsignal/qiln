import { and, asc, eq } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  CapsuleSnapshotCaptureReceiptSchema,
  capsuleBranchesTable,
  capsuleBranchResourcesTable,
  capsuleCreateOperationsTable,
  capsuleOperationsTable,
  capsuleSnapshotCaptureOperationsTable,
  capsuleSnapshotCaptureResourcesTable,
  capsulesTable,
  createCapsuleSnapshotCapturePolicyPin,
  type CapsuleBlueprint,
  type CapsuleHostDbContract,
  type CapsuleOperationStatusValue,
  type CapsuleSnapshotCapturePolicyPin,
  type CapsuleSnapshotCaptureReceipt,
} from '@qiln/core/server'
import { IncusError, isUniqueConstraintViolation } from '../../../../../errors'
import {
  assertOperationReplayIdentity,
  toCapsuleLifecycleState,
  toCapsuleOperationTransition,
  type CapsuleOperationReader,
  type PersistedCapsuleOperation,
} from '../../shared'
import type { CapsuleBranchResourceInventoryRow } from '../../../resource'
import type { CapturePlanner } from '../plan'
import type { AcceptCaptureCapsuleInput, CaptureAcceptanceResult, CaptureSourceBranch } from '../types'

type CaptureTransaction = Parameters<Parameters<CapsuleHostDbContract['transaction']>[0]>[0]

/**
 * Owns atomic Snapshot Capture acceptance and idempotent replay.
 *
 * Acceptance persists immutable input, planned provider identities, and the
 * source-branch capture fence in one transaction. It performs no provider
 * mutation and does not schedule an executor.
 */
export class CaptureAcceptancePersistence {
  constructor(
    private readonly db: CapsuleHostDbContract,
    private readonly reader: CapsuleOperationReader,
    private readonly planner: CapturePlanner,
  ) {}

  public async accept(input: AcceptCaptureCapsuleInput): Promise<CaptureAcceptanceResult> {
    const replay = await this.findReplay(input.ownerId, input.actor, input.idempotencyKey, input.requestHash)
    if (replay) {
      return replay
    }
    try {
      return await this.db.transaction(async tx => {
        const capsule = await this.lockCapsule(tx, input.ownerId, input.capsuleId)
        if (capsule.lifecycleStatus !== 'active' || capsule.archivedAt !== null) {
          throw new IncusError('Only an active, unarchived capsule can begin Snapshot Capture.', 'CONFLICT', {
            ownerId: input.ownerId,
            capsuleId: input.capsuleId,
            lifecycleStatus: capsule.lifecycleStatus,
            archived: capsule.archivedAt !== null,
          })
        }

        const branch = await this.lockBranch(tx, input.ownerId, input.capsuleId, input.sourceBranchId)
        if (!branch.isRootBranch || branch.status !== 'offline') {
          throw new IncusError('Evaluation-only Snapshot Capture requires the offline root branch.', 'CONFLICT', {
            ownerId: input.ownerId,
            capsuleId: input.capsuleId,
            sourceBranchId: input.sourceBranchId,
            sourceBranchStatus: branch.status,
            isRootBranch: branch.isRootBranch,
          })
        }
        if (branch.resourceInventoryDigest === null) {
          throw new IncusError('Snapshot Capture source branch has no durable resource inventory proof.', 'CONFLICT', {
            ownerId: input.ownerId,
            capsuleId: input.capsuleId,
            sourceBranchId: input.sourceBranchId,
          })
        }
        const resources = await this.lockInventory(tx, branch.id)
        const policy = await this.loadPolicy(tx, branch)
        const now = new Date()
        const [operation] = await tx
          .insert(capsuleOperationsTable)
          .values({
            ownerId: input.ownerId,
            actorType: input.actor.type,
            actorId: input.actor.id,
            capsuleId: input.capsuleId,
            type: CapsuleOperationType.SNAPSHOT_CAPTURE,
            status: CapsuleOperationStatus.ACCEPTED,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            acceptedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: capsuleOperationsTable.id,
            ownerId: capsuleOperationsTable.ownerId,
            capsuleId: capsuleOperationsTable.capsuleId,
            status: capsuleOperationsTable.status,
          })
        if (!operation) {
          throw new IncusError('Failed to durably accept the Snapshot Capture operation.', 'API_ERROR')
        }
        const plan = this.planner.create(operation.id, input.ownerId, input.capsuleId, branch, policy, resources)
        const [extension] = await tx
          .insert(capsuleSnapshotCaptureOperationsTable)
          .values({
            operationId: operation.id,
            sourceBranchId: branch.id,
            sourceBranchName: branch.name,
            sourceBranchResourceInventoryDigest: branch.resourceInventoryDigest,
            capturePolicySchemaVersion: policy.schemaVersion,
            capturePolicyDigest: policy.digest,
            capturePolicyPin: policy,
            snapshotId: null,
          })
          .returning({
            operationId: capsuleSnapshotCaptureOperationsTable.operationId,
          })
        if (!extension || extension.operationId !== operation.id) {
          throw new IncusError('Failed to persist immutable Snapshot Capture operation input.', 'API_ERROR', {
            operationId: operation.id,
            capsuleId: operation.capsuleId,
            sourceBranchId: branch.id,
          })
        }
        const plannedResources = await tx
          .insert(capsuleSnapshotCaptureResourcesTable)
          .values(
            plan.roots.map(root => ({
              operationId: operation.id,
              sourceBranchResourceId: root.sourceBranchResourceId,
              artifactRootId: root.artifactRootId,
              blueprintVolumeName: root.blueprintVolumeName,
              provider: root.provider,
              kind: root.kind,
              project: root.project,
              pool: root.pool,
              sourceVolume: root.sourceVolume,
              snapshotName: root.snapshotName,
              status: 'planned' as const,
              createdAt: now,
              updatedAt: now,
            })),
          )
          .returning({
            id: capsuleSnapshotCaptureResourcesTable.id,
          })
        if (plannedResources.length !== plan.roots.length) {
          throw new IncusError('Failed to persist complete Snapshot Capture provider resource planning.', 'API_ERROR', {
            operationId: operation.id,
            expectedResourceCount: plan.roots.length,
            insertedResourceCount: plannedResources.length,
          })
        }
        const [capturingBranch] = await tx
          .update(capsuleBranchesTable)
          .set({
            status: 'capturing',
            runtimeIp: null,
            runtimeErrorCode: null,
            runtimeErrorMessage: null,
            runtimeErrorDetails: null,
            runtimeErrorAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(capsuleBranchesTable.id, branch.id),
              eq(capsuleBranchesTable.ownerId, input.ownerId),
              eq(capsuleBranchesTable.capsuleId, input.capsuleId),
              eq(capsuleBranchesTable.status, 'offline'),
            ),
          )
          .returning({
            id: capsuleBranchesTable.id,
            capsuleId: capsuleBranchesTable.capsuleId,
            name: capsuleBranchesTable.name,
            status: capsuleBranchesTable.status,
          })

        if (!capturingBranch) {
          throw new IncusError(
            'Failed to transition the Snapshot Capture source branch into its capture fence.',
            'CONFLICT',
            {
              operationId: operation.id,
              capsuleId: operation.capsuleId,
              sourceBranchId: branch.id,
            },
          )
        }
        return {
          newlyAccepted: true,
          receipt: this.receipt({
            operationId: operation.id,
            operationStatus: operation.status,
            capsuleId: operation.capsuleId,
            sourceBranchId: branch.id,
            sourceBranchName: branch.name,
            replayed: false,
          }),
          operation: toCapsuleOperationTransition({
            ownerId: operation.ownerId,
            operationId: operation.id,
            operationType: CapsuleOperationType.SNAPSHOT_CAPTURE,
            operationStatus: operation.status,
            capsuleId: operation.capsuleId,
          }),
          capsule: toCapsuleLifecycleState({
            capsuleId: operation.capsuleId,
            lifecycleStatus: capsule.lifecycleStatus,
            archivedAt: capsule.archivedAt,
            destroyedAt: capsule.destroyedAt,
          }),
          branch: capturingBranch,
        }
      })
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error
      }
      const racedReplay = await this.findReplay(input.ownerId, input.actor, input.idempotencyKey, input.requestHash)
      if (racedReplay) {
        return racedReplay
      }
      throw new IncusError('Snapshot Capture conflicts with another durable capsule operation.', 'CONFLICT', {
        ownerId: input.ownerId,
        capsuleId: input.capsuleId,
        sourceBranchId: input.sourceBranchId,
      })
    }
  }

  private async findReplay(
    ownerId: string,
    actor: AcceptCaptureCapsuleInput['actor'],
    idempotencyKey: string,
    requestHash: AcceptCaptureCapsuleInput['requestHash'],
  ): Promise<CaptureAcceptanceResult | null> {
    const operation = await this.reader.loadByOwnerAndIdempotencyKey(ownerId, idempotencyKey)
    if (!operation) {
      return null
    }

    assertOperationReplayIdentity(operation, {
      operationType: CapsuleOperationType.SNAPSHOT_CAPTURE,
      actor,
      requestHash,
      requestDescription: 'Snapshot Capture',
    })

    return await this.result(operation, false, true)
  }

  private async result(
    operation: PersistedCapsuleOperation,
    newlyAccepted: boolean,
    replayed: boolean,
  ): Promise<CaptureAcceptanceResult> {
    const [extension] = await this.db
      .select()
      .from(capsuleSnapshotCaptureOperationsTable)
      .where(eq(capsuleSnapshotCaptureOperationsTable.operationId, operation.id))
      .limit(1)
    if (!extension) {
      throw new IncusError('Snapshot Capture operation is missing its immutable operation extension.', 'API_ERROR', {
        operationId: operation.id,
        capsuleId: operation.capsuleId,
      })
    }
    const [capsule] = await this.db
      .select()
      .from(capsulesTable)
      .where(and(eq(capsulesTable.id, operation.capsuleId), eq(capsulesTable.ownerId, operation.ownerId)))
      .limit(1)
    const [branch] = await this.db
      .select({
        id: capsuleBranchesTable.id,
        capsuleId: capsuleBranchesTable.capsuleId,
        name: capsuleBranchesTable.name,
        status: capsuleBranchesTable.status,
      })
      .from(capsuleBranchesTable)
      .where(
        and(
          eq(capsuleBranchesTable.id, extension.sourceBranchId),
          eq(capsuleBranchesTable.ownerId, operation.ownerId),
          eq(capsuleBranchesTable.capsuleId, operation.capsuleId),
        ),
      )
      .limit(1)
    if (!capsule || !branch || branch.name !== extension.sourceBranchName) {
      throw new IncusError(
        'Snapshot Capture replay references incomplete or contradictory durable aggregate state.',
        'API_ERROR',
        {
          operationId: operation.id,
          capsuleId: operation.capsuleId,
          sourceBranchId: extension.sourceBranchId,
        },
      )
    }
    return {
      newlyAccepted,
      receipt: this.receipt({
        operationId: operation.id,
        operationStatus: operation.status,
        capsuleId: operation.capsuleId,
        sourceBranchId: extension.sourceBranchId,
        sourceBranchName: extension.sourceBranchName,
        replayed,
      }),
      operation: toCapsuleOperationTransition({
        ownerId: operation.ownerId,
        operationId: operation.id,
        operationType: CapsuleOperationType.SNAPSHOT_CAPTURE,
        operationStatus: operation.status,
        capsuleId: operation.capsuleId,
      }),
      capsule: toCapsuleLifecycleState({
        capsuleId: operation.capsuleId,
        lifecycleStatus: capsule.lifecycleStatus,
        archivedAt: capsule.archivedAt,
        destroyedAt: capsule.destroyedAt,
      }),
      branch,
    }
  }

  private receipt(input: {
    operationId: string
    operationStatus: CapsuleOperationStatusValue
    capsuleId: string
    sourceBranchId: string
    sourceBranchName: string
    replayed: boolean
  }): CapsuleSnapshotCaptureReceipt {
    return CapsuleSnapshotCaptureReceiptSchema.parse({
      operationId: input.operationId,
      operationType: CapsuleOperationType.SNAPSHOT_CAPTURE,
      operationStatus: input.operationStatus,
      capsuleId: input.capsuleId,
      sourceBranchId: input.sourceBranchId,
      sourceBranchName: input.sourceBranchName,
      replayed: input.replayed,
    })
  }

  private async lockCapsule(tx: CaptureTransaction, ownerId: string, capsuleId: string) {
    const [capsule] = await tx
      .select()
      .from(capsulesTable)
      .where(and(eq(capsulesTable.id, capsuleId), eq(capsulesTable.ownerId, ownerId)))
      .for('update')
      .limit(1)
    if (!capsule) {
      throw new IncusError('Capsule not found or access denied.', 'NOT_FOUND', {
        ownerId,
        capsuleId,
      })
    }
    return capsule
  }

  private async lockBranch(
    tx: CaptureTransaction,
    ownerId: string,
    capsuleId: string,
    branchId: string,
  ): Promise<CaptureSourceBranch> {
    const [branch] = await tx
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
      .for('update')
      .limit(1)
    if (!branch) {
      throw new IncusError('Snapshot Capture source branch not found or access denied.', 'NOT_FOUND', {
        ownerId,
        capsuleId,
        sourceBranchId: branchId,
      })
    }
    return branch
  }

  private async lockInventory(tx: CaptureTransaction, branchId: string): Promise<CapsuleBranchResourceInventoryRow[]> {
    return await tx
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
      .for('update')
  }

  private async loadPolicy(
    tx: CaptureTransaction,
    branch: CaptureSourceBranch,
  ): Promise<CapsuleSnapshotCapturePolicyPin> {
    const [extension] = await tx
      .select()
      .from(capsuleCreateOperationsTable)
      .where(eq(capsuleCreateOperationsTable.rootBranchId, branch.id))
      .for('update')
      .limit(1)

    if (!extension) {
      throw new IncusError(
        'Snapshot Capture root branch is missing its immutable create operation input.',
        'CONFLICT',
        {
          sourceBranchId: branch.id,
          capsuleId: branch.capsuleId,
        },
      )
    }
    const [createOperation] = await tx
      .select()
      .from(capsuleOperationsTable)
      .where(eq(capsuleOperationsTable.id, extension.operationId))
      .for('update')
      .limit(1)
    if (
      !createOperation ||
      createOperation.type !== CapsuleOperationType.CREATE ||
      createOperation.status !== CapsuleOperationStatus.COMPLETED ||
      createOperation.completedAt === null ||
      createOperation.ownerId !== branch.ownerId ||
      createOperation.capsuleId !== branch.capsuleId ||
      extension.rootBranchName !== branch.name ||
      extension.blueprintName !== branch.blueprintName ||
      extension.blueprintDigest !== branch.blueprintDigest ||
      extension.cpu !== branch.cpu ||
      extension.memory !== branch.memory
    ) {
      throw new IncusError(
        'Snapshot Capture source branch does not match a completed immutable create operation.',
        'CONFLICT',
        {
          sourceBranchId: branch.id,
          capsuleId: branch.capsuleId,
          createOperationId: extension.operationId,
        },
      )
    }
    return createCapsuleSnapshotCapturePolicyPin({
      name: extension.blueprintName,
      digest: extension.blueprintDigest,
      blueprint: extension.blueprintSnapshot as CapsuleBlueprint,
    })
  }
}
