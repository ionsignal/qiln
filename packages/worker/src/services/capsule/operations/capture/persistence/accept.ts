import { and, asc, eq } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  CapsuleSnapshotCaptureReceiptSchema,
  createCapsuleSnapshotCapturePolicyPin,
  type CapsuleBlueprint,
  type CapsuleOperationStatusValue,
  type CapsuleSnapshotCapturePolicyPin,
  type CapsuleSnapshotCaptureReceipt,
  type QilnPersistence,
  type QilnTables,
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
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

/**
 * Owns atomic Snapshot Capture acceptance and idempotent replay.
 *
 * Acceptance persists immutable input, planned provider identities, and the
 * source-branch capture fence in one transaction. It performs no provider
 * mutation and does not schedule an executor.
 */
export class CaptureAcceptancePersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends QilnTables = QilnTables,
> {
  constructor(
    private readonly persistence: QilnPersistence<TDatabase, TTables>,
    private readonly reader: CapsuleOperationReader<TDatabase, TTables>,
    private readonly planner: CapturePlanner,
  ) {}

  public async accept(input: AcceptCaptureCapsuleInput): Promise<CaptureAcceptanceResult> {
    const replay = await this.findReplay(input.ownerId, input.actor, input.idempotencyKey, input.requestHash)
    if (replay) {
      return replay
    }
    const db = this.persistence.db
    const { capsuleBranches, capsuleOperations, capsuleSnapshotCaptureOperations, capsuleSnapshotCaptureResources } =
      this.persistence.tables
    try {
      return await db.transaction(async tx => {
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
          .insert(capsuleOperations)
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
            id: capsuleOperations.id,
            ownerId: capsuleOperations.ownerId,
            capsuleId: capsuleOperations.capsuleId,
            status: capsuleOperations.status,
          })
        if (!operation) {
          throw new IncusError('Failed to durably accept the Snapshot Capture operation.', 'API_ERROR')
        }
        const plan = this.planner.create(operation.id, input.ownerId, input.capsuleId, branch, policy, resources)
        const [extension] = await tx
          .insert(capsuleSnapshotCaptureOperations)
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
            operationId: capsuleSnapshotCaptureOperations.operationId,
          })
        if (!extension || extension.operationId !== operation.id) {
          throw new IncusError('Failed to persist immutable Snapshot Capture operation input.', 'API_ERROR', {
            operationId: operation.id,
            capsuleId: operation.capsuleId,
            sourceBranchId: branch.id,
          })
        }
        const plannedResources = await tx
          .insert(capsuleSnapshotCaptureResources)
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
            id: capsuleSnapshotCaptureResources.id,
          })
        if (plannedResources.length !== plan.roots.length) {
          throw new IncusError('Failed to persist complete Snapshot Capture provider resource planning.', 'API_ERROR', {
            operationId: operation.id,
            expectedResourceCount: plan.roots.length,
            insertedResourceCount: plannedResources.length,
          })
        }
        const [capturingBranch] = await tx
          .update(capsuleBranches)
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
              eq(capsuleBranches.id, branch.id),
              eq(capsuleBranches.ownerId, input.ownerId),
              eq(capsuleBranches.capsuleId, input.capsuleId),
              eq(capsuleBranches.status, 'offline'),
            ),
          )
          .returning({
            id: capsuleBranches.id,
            capsuleId: capsuleBranches.capsuleId,
            name: capsuleBranches.name,
            status: capsuleBranches.status,
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
    const db = this.persistence.db
    const { capsules, capsuleBranches, capsuleSnapshotCaptureOperations } = this.persistence.tables
    const [extension] = await db
      .select()
      .from(capsuleSnapshotCaptureOperations)
      .where(eq(capsuleSnapshotCaptureOperations.operationId, operation.id))
      .limit(1)
    if (!extension) {
      throw new IncusError('Snapshot Capture operation is missing its immutable operation extension.', 'API_ERROR', {
        operationId: operation.id,
        capsuleId: operation.capsuleId,
      })
    }
    const [capsule] = await db
      .select()
      .from(capsules)
      .where(and(eq(capsules.id, operation.capsuleId), eq(capsules.ownerId, operation.ownerId)))
      .limit(1)
    const [branch] = await db
      .select({
        id: capsuleBranches.id,
        capsuleId: capsuleBranches.capsuleId,
        name: capsuleBranches.name,
        status: capsuleBranches.status,
      })
      .from(capsuleBranches)
      .where(
        and(
          eq(capsuleBranches.id, extension.sourceBranchId),
          eq(capsuleBranches.ownerId, operation.ownerId),
          eq(capsuleBranches.capsuleId, operation.capsuleId),
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

  private async lockCapsule(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    ownerId: string,
    capsuleId: string,
  ) {
    const capsules = this.persistence.tables.capsules
    const [capsule] = await tx
      .select()
      .from(capsules)
      .where(and(eq(capsules.id, capsuleId), eq(capsules.ownerId, ownerId)))
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
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    ownerId: string,
    capsuleId: string,
    branchId: string,
  ): Promise<CaptureSourceBranch> {
    const capsuleBranches = this.persistence.tables.capsuleBranches
    const [branch] = await tx
      .select({
        id: capsuleBranches.id,
        ownerId: capsuleBranches.ownerId,
        capsuleId: capsuleBranches.capsuleId,
        name: capsuleBranches.name,
        status: capsuleBranches.status,
        isRootBranch: capsuleBranches.isRootBranch,
        blueprintName: capsuleBranches.blueprintName,
        blueprintDigest: capsuleBranches.blueprintDigest,
        cpu: capsuleBranches.cpu,
        memory: capsuleBranches.memory,
        resourceInventoryDigest: capsuleBranches.resourceInventoryDigest,
      })
      .from(capsuleBranches)
      .where(
        and(
          eq(capsuleBranches.id, branchId),
          eq(capsuleBranches.ownerId, ownerId),
          eq(capsuleBranches.capsuleId, capsuleId),
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

  private async lockInventory(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    branchId: string,
  ): Promise<CapsuleBranchResourceInventoryRow[]> {
    const capsuleBranchResources = this.persistence.tables.capsuleBranchResources
    return await tx
      .select({
        id: capsuleBranchResources.id,
        ownerId: capsuleBranchResources.ownerId,
        branchId: capsuleBranchResources.branchId,
        branchName: capsuleBranchResources.branchName,
        provider: capsuleBranchResources.provider,
        resourceType: capsuleBranchResources.resourceType,
        resourceKey: capsuleBranchResources.resourceKey,
        blueprintVolumeName: capsuleBranchResources.blueprintVolumeName,
        status: capsuleBranchResources.status,
        cleanupPolicy: capsuleBranchResources.cleanupPolicy,
        metadata: capsuleBranchResources.metadata,
        createdByOperationId: capsuleBranchResources.createdByOperationId,
        lastOperationId: capsuleBranchResources.lastOperationId,
      })
      .from(capsuleBranchResources)
      .where(eq(capsuleBranchResources.branchId, branchId))
      .orderBy(asc(capsuleBranchResources.createdAt), asc(capsuleBranchResources.id))
      .for('update')
  }

  private async loadPolicy(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    branch: CaptureSourceBranch,
  ): Promise<CapsuleSnapshotCapturePolicyPin> {
    const { capsuleCreateOperations, capsuleOperations } = this.persistence.tables
    const [extension] = await tx
      .select()
      .from(capsuleCreateOperations)
      .where(eq(capsuleCreateOperations.rootBranchId, branch.id))
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
      .from(capsuleOperations)
      .where(eq(capsuleOperations.id, extension.operationId))
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
