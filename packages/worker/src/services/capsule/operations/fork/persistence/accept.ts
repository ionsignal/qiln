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
} from '../../shared'
import type { ForkPlanner } from '../plan'
import type { AcceptForkInput, ForkAcceptance, ForkBranch, ForkPlannedResource } from '../types'
import { assertForkEvidence, ForkSourcePersistence } from './source'
import type { ForkLocks, ForkScope, ForkTransaction } from './locks'

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
    private readonly locks: ForkLocks<TDatabase, TTables>,
  ) {}

  public async accept(input: AcceptForkInput): Promise<ForkAcceptance> {
    const replay = await this.replay(input)
    if (replay) {
      return replay
    }
    const tables = this.persistence.tables
    try {
      return await this.persistence.db.transaction(async tx => {
        const capsule = await this.locks.capsule(tx, input.ownerId, input.capsuleId)
        const replay = await this.replayLocked(tx, input)
        if (replay) {
          return replay
        }
        if (capsule.lifecycleStatus !== 'active' || capsule.archivedAt !== null) {
          throw new IncusError('Only an active, unarchived capsule can fork a branch.', 'CONFLICT', {
            ownerId: input.ownerId,
            capsuleId: input.capsuleId,
            lifecycleStatus: capsule.lifecycleStatus,
            archived: capsule.archivedAt !== null,
          })
        }
        const source = await this.sources.read(tx, input.ownerId, input.capsuleId, input.sourceSnapshotId)
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
          .returning()
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
          .returning()
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
            cpu: input.cpu,
            memory: input.memory,
          })
          .returning()
        if (!extension) {
          throw new IncusError('Failed to persist immutable capsule fork input.', 'API_ERROR', {
            operationId: operation.id,
            branchId: branch.id,
          })
        }
        const resources = await tx
          .insert(tables.capsuleBranchResources)
          .values(
            plan.resources.map(resource => this.resourceValue(operation.id, input.ownerId, branch, resource, now)),
          )
          .returning()
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
          .returning()
        if (!provedBranch) {
          throw new IncusError('Failed to commit the fork branch resource inventory proof.', 'CONFLICT', {
            operationId: operation.id,
            branchId: branch.id,
          })
        }

        assertForkEvidence(operation, extension, source, provedBranch)

        this.planner.assertResources({
          operationId: operation.id,
          ownerId: operation.ownerId,
          branchId: provedBranch.id,
          branchName: provedBranch.name,
          extensionInventoryDigest: extension.targetBranchResourceInventoryDigest,
          branchInventoryDigest: provedBranch.resourceInventoryDigest,
          stage: 'accepted',
          plan,
          resources,
        })

        return this.result(
          {
            operation,
            capsule,
            extension,
            branch: provedBranch,
          },
          false,
        )
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

    if (operation.capsuleId !== input.capsuleId) {
      throw new IncusError('Capsule fork replay belongs to another capsule.', 'CONFLICT', {
        operationId: operation.id,
      })
    }
    return await this.persistence.db.transaction(async tx => {
      await this.locks.capsule(tx, input.ownerId, input.capsuleId)
      return await this.replayLocked(tx, input)
    })
  }

  /**
   * The caller holds the requested capsule lock before checking replay and
   * before checking mutable lifecycle eligibility.
   *
   * The operation is reloaded under that lock so receipt status and aggregate
   * state never come from different reads around a concurrent completion.
   */
  private async replayLocked(tx: ForkTransaction<TDatabase>, input: AcceptForkInput): Promise<ForkAcceptance | null> {
    const operations = this.persistence.tables.capsuleOperations
    const [existing] = await tx
      .select()
      .from(operations)
      .where(and(eq(operations.ownerId, input.ownerId), eq(operations.idempotencyKey, input.idempotencyKey)))
      .limit(1)
    if (!existing) {
      return null
    }
    this.assertReplay(existing, input)
    const scope = await this.locks.scope(tx, existing.id)
    this.assertReplay(scope.operation, input)
    if (
      !scope.extension ||
      !scope.branch ||
      scope.extension.sourceSnapshotId !== input.sourceSnapshotId ||
      scope.extension.targetBranchName !== input.branchName ||
      scope.extension.cpu !== input.cpu ||
      scope.extension.memory !== input.memory
    ) {
      throw new IncusError('Capsule fork replay has contradictory immutable input.', 'CONFLICT', {
        operationId: scope.operation.id,
      })
    }
    const source = await this.sources.read(
      tx,
      scope.operation.ownerId,
      scope.operation.capsuleId,
      scope.extension.sourceSnapshotId,
    )

    assertForkEvidence(scope.operation, scope.extension, source, scope.branch)

    return this.result(scope, true)
  }

  private assertReplay(operation: ForkScope['operation'], input: AcceptForkInput): void {
    assertOperationReplayIdentity(
      {
        id: operation.id,
        type: operation.type,
        requestHash: operation.requestHash,
        actor: {
          type: operation.actorType,
          id: operation.actorId,
        },
      },
      {
        actor: input.actor,
        operationType: CapsuleOperationType.FORK,
        requestHash: input.requestHash,
        requestDescription: 'capsule fork',
      },
    )
    if (
      operation.ownerId !== input.ownerId ||
      operation.capsuleId !== input.capsuleId ||
      operation.idempotencyKey !== input.idempotencyKey
    ) {
      throw new IncusError('Capsule fork replay no longer matches its durable request identity.', 'CONFLICT', {
        operationId: operation.id,
      })
    }
  }

  private result(scope: ForkScope, replayed: boolean): ForkAcceptance {
    const { operation, capsule, extension, branch } = scope
    if (!extension || !branch) {
      throw new IncusError(
        'Capsule fork receipt requires an immutable extension and owned target branch.',
        'CONFLICT',
        {
          operationId: operation.id,
        },
      )
    }
    return {
      newlyAccepted: !replayed,
      receipt: this.receipt({
        operationId: operation.id,
        operationStatus: operation.status,
        capsuleId: operation.capsuleId,
        sourceSnapshotId: extension.sourceSnapshotId,
        branchId: extension.targetBranchId,
        branchName: extension.targetBranchName,
        replayed,
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
}
