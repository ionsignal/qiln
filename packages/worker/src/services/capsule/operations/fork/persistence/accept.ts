import { and, eq } from 'drizzle-orm'
import {
  CapsuleBranchResourceStatus,
  CapsuleForkReceiptSchema,
  CapsuleOperationStatus,
  CapsuleOperationType,
  type CapsuleForkReceipt,
  type CapsuleOperationStatusValue,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError, isUniqueConstraintViolation } from '../../../../../errors'
import {
  assertOperationReplayIdentity,
  toCapsuleLifecycleState,
  toCapsuleOperationTransition,
  type CapsuleOperationReader,
  type PersistedCapsuleOperation,
} from '../../shared'
import type { ForkPlanner } from '../plan'
import type { AcceptForkInput, ForkAcceptance, ForkBranch, ForkPlannedResource } from '../types'
import { assertForkEvidence, ForkSourcePersistence } from './source'

/**
 * Owns atomic fork acceptance and race-safe idempotent replay.
 *
 * Acceptance persists the base operation, provisional branch, immutable source
 * evidence, and complete target resource plan before any provider mutation.
 */
export class ForkAcceptancePersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly reader: CapsuleOperationReader<TDatabase, TTables>,
    private readonly planner: ForkPlanner,
    private readonly sources: ForkSourcePersistence<TDatabase, TTables>,
  ) {}

  public async accept(input: AcceptForkInput): Promise<ForkAcceptance> {
    const replay = await this.replay(input)
    if (replay) {
      return replay
    }
    const tables = this.persistence.tables
    try {
      return await this.persistence.db.transaction(async tx => {
        const capsule = await this.lockCapsule(tx, input.ownerId, input.capsuleId)
        if (capsule.lifecycleStatus !== 'active' || capsule.archivedAt !== null) {
          throw new IncusError('Only an active, unarchived capsule can fork a branch.', 'CONFLICT', {
            ownerId: input.ownerId,
            capsuleId: input.capsuleId,
            lifecycleStatus: capsule.lifecycleStatus,
            archived: capsule.archivedAt !== null,
          })
        }
        const source = await this.sources.lock(tx, input.ownerId, input.capsuleId, input.sourceSnapshotId)
        const now = new Date()
        const [operation] = await tx
          .insert(tables.capsuleOperations)
          .values({
            ownerId: input.ownerId,
            actorType: input.actor.type,
            actorId: input.actor.id,
            capsuleId: input.capsuleId,
            type: CapsuleOperationType.FORK,
            status: CapsuleOperationStatus.ACCEPTED,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            acceptedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: tables.capsuleOperations.id,
            ownerId: tables.capsuleOperations.ownerId,
            capsuleId: tables.capsuleOperations.capsuleId,
            status: tables.capsuleOperations.status,
          })
        if (!operation) {
          throw new IncusError('Failed to accept the capsule fork operation.', 'API_ERROR')
        }
        const [branch] = await tx
          .insert(tables.capsuleBranches)
          .values({
            ownerId: input.ownerId,
            capsuleId: input.capsuleId,
            name: input.branchName,
            cpu: input.cpu,
            memory: input.memory,
            blueprintName: source.blueprint.name,
            blueprintDigest: source.blueprint.digest,
            status: 'provisioning',
            isRootBranch: false,
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: tables.capsuleBranches.id,
            capsuleId: tables.capsuleBranches.capsuleId,
            name: tables.capsuleBranches.name,
            status: tables.capsuleBranches.status,
          })
        if (!branch) {
          throw new IncusError('Failed to create the provisional fork branch.', 'API_ERROR', {
            operationId: operation.id,
            capsuleId: operation.capsuleId,
          })
        }
        const plan = this.planner.create({
          operationId: operation.id,
          ownerId: operation.ownerId,
          branchId: branch.id,
          branchName: branch.name,
          cpu: input.cpu,
          memory: input.memory,
          source,
        })
        const [extension] = await tx
          .insert(tables.capsuleForkOperations)
          .values({
            operationId: operation.id,
            sourceSnapshotId: source.snapshotId,
            targetBranchId: branch.id,
            targetBranchName: input.branchName,
            targetBranchResourceInventoryDigest: plan.inventoryDigest,
            blueprintSchemaVersion: source.blueprint.blueprint.schema_version,
            blueprintName: source.blueprint.name,
            blueprintDigest: source.blueprint.digest,
            blueprintPin: source.blueprint,
            rootfsImagePin: source.rootfsImagePin,
            capturePolicySchemaVersion: source.capturePolicy.schemaVersion,
            capturePolicyDigest: source.capturePolicy.digest,
            capturePolicyPin: source.capturePolicy,
            sourceSnapshotMode: source.mode,
            sourceSnapshotLimitations: source.limitations,
            cpu: input.cpu,
            memory: input.memory,
          })
          .returning({
            operationId: tables.capsuleForkOperations.operationId,
            targetBranchId: tables.capsuleForkOperations.targetBranchId,
          })
        if (!extension || extension.operationId !== operation.id || extension.targetBranchId !== branch.id) {
          throw new IncusError('Failed to persist immutable capsule fork input.', 'API_ERROR', {
            operationId: operation.id,
            branchId: branch.id,
          })
        }
        const resourceRows = await tx
          .insert(tables.capsuleBranchResources)
          .values(
            plan.resources.map(resource => this.resourceValue(operation.id, input.ownerId, branch, resource, now)),
          )
          .returning({
            id: tables.capsuleBranchResources.id,
          })
        if (resourceRows.length !== plan.resources.length) {
          throw new IncusError('Failed to persist the complete fork branch resource plan.', 'API_ERROR', {
            operationId: operation.id,
            expectedResourceCount: plan.resources.length,
            insertedResourceCount: resourceRows.length,
          })
        }
        const [provedBranch] = await tx
          .update(tables.capsuleBranches)
          .set({
            resourceInventoryDigest: plan.inventoryDigest,
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
        if (!provedBranch) {
          throw new IncusError('Failed to commit the fork branch resource inventory proof.', 'CONFLICT', {
            operationId: operation.id,
            branchId: branch.id,
          })
        }
        return {
          newlyAccepted: true,
          receipt: this.receipt({
            operationId: operation.id,
            operationStatus: operation.status,
            capsuleId: operation.capsuleId,
            sourceSnapshotId: source.snapshotId,
            branchId: branch.id,
            branchName: branch.name,
            replayed: false,
          }),
          operation: toCapsuleOperationTransition({
            ownerId: operation.ownerId,
            operationId: operation.id,
            operationType: CapsuleOperationType.FORK,
            operationStatus: operation.status,
            capsuleId: operation.capsuleId,
          }),
          capsule: toCapsuleLifecycleState({
            capsuleId: operation.capsuleId,
            lifecycleStatus: capsule.lifecycleStatus,
            archivedAt: capsule.archivedAt,
            destroyedAt: capsule.destroyedAt,
          }),
          branch: provedBranch,
        }
      })
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error
      }
      const replay = await this.replay(input)
      if (replay) {
        return replay
      }
      throw new IncusError('Capsule fork conflicts with existing durable state.', 'CONFLICT', {
        ownerId: input.ownerId,
        capsuleId: input.capsuleId,
        sourceSnapshotId: input.sourceSnapshotId,
        branchName: input.branchName,
      })
    }
  }

  private async replay(input: AcceptForkInput): Promise<ForkAcceptance | null> {
    const operation = await this.reader.loadByOwnerAndIdempotencyKey(input.ownerId, input.idempotencyKey)
    if (!operation) {
      return null
    }

    assertOperationReplayIdentity(operation, {
      actor: input.actor,
      operationType: CapsuleOperationType.FORK,
      requestHash: input.requestHash,
      requestDescription: 'capsule fork',
    })

    return await this.result(operation)
  }

  private async result(operation: PersistedCapsuleOperation): Promise<ForkAcceptance> {
    return await this.persistence.db.transaction(async tx => {
      const tables = this.persistence.tables
      const [extension] = await tx
        .select()
        .from(tables.capsuleForkOperations)
        .where(eq(tables.capsuleForkOperations.operationId, operation.id))
        .for('update')
        .limit(1)
      if (!extension) {
        throw new IncusError('Capsule fork operation is missing immutable input.', 'API_ERROR', {
          operationId: operation.id,
        })
      }
      const capsule = await this.lockCapsule(tx, operation.ownerId, operation.capsuleId)
      const source = await this.sources.lock(tx, operation.ownerId, operation.capsuleId, extension.sourceSnapshotId)
      const branch = await this.lockBranch(tx, operation.ownerId, operation.capsuleId, extension.targetBranchId)

      assertForkEvidence(operation, extension, source, branch)

      return {
        newlyAccepted: false,
        receipt: this.receipt({
          operationId: operation.id,
          operationStatus: operation.status,
          capsuleId: operation.capsuleId,
          sourceSnapshotId: extension.sourceSnapshotId,
          branchId: extension.targetBranchId,
          branchName: extension.targetBranchName,
          replayed: true,
        }),
        operation: toCapsuleOperationTransition({
          ownerId: operation.ownerId,
          operationId: operation.id,
          operationType: CapsuleOperationType.FORK,
          operationStatus: operation.status,
          capsuleId: operation.capsuleId,
        }),
        capsule: toCapsuleLifecycleState({
          capsuleId: operation.capsuleId,
          lifecycleStatus: capsule.lifecycleStatus,
          archivedAt: capsule.archivedAt,
          destroyedAt: capsule.destroyedAt,
        }),
        branch: {
          id: branch.id,
          capsuleId: branch.capsuleId,
          name: branch.name,
          status: branch.status,
        },
      }
    })
  }

  private receipt(input: {
    operationId: string
    operationStatus: CapsuleOperationStatusValue
    capsuleId: string
    sourceSnapshotId: string
    branchId: string
    branchName: string
    replayed: boolean
  }): CapsuleForkReceipt {
    return CapsuleForkReceiptSchema.parse({
      operationId: input.operationId,
      operationType: CapsuleOperationType.FORK,
      operationStatus: input.operationStatus,
      capsuleId: input.capsuleId,
      sourceSnapshotId: input.sourceSnapshotId,
      branchId: input.branchId,
      branchName: input.branchName,
      replayed: input.replayed,
    })
  }

  private resourceValue(
    operationId: string,
    ownerId: string,
    branch: ForkBranch,
    resource: ForkPlannedResource,
    now: Date,
  ) {
    return {
      ownerId,
      branchId: branch.id,
      branchName: branch.name,
      createdByOperationId: operationId,
      lastOperationId: operationId,
      resourceType: resource.resourceType,
      provider: resource.provider,
      resourceKey: resource.resourceKey,
      blueprintVolumeName: resource.blueprintVolumeName,
      status: CapsuleBranchResourceStatus.PLANNED,
      cleanupPolicy: resource.cleanupPolicy,
      metadata: resource.metadata,
      createdAt: now,
      updatedAt: now,
    }
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
  ) {
    const branches = this.persistence.tables.capsuleBranches
    const [branch] = await tx
      .select()
      .from(branches)
      .where(and(eq(branches.id, branchId), eq(branches.ownerId, ownerId), eq(branches.capsuleId, capsuleId)))
      .for('update')
      .limit(1)
    if (!branch) {
      throw new IncusError('Capsule fork target branch was not found.', 'NOT_FOUND', {
        ownerId,
        capsuleId,
        branchId,
      })
    }
    return branch
  }
}
