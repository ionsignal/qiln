import { and, asc, eq, isNotNull } from 'drizzle-orm'
import {
  CapsuleDestroyReceiptSchema,
  CapsuleOperationStatus,
  CapsuleOperationType,
  capsuleBranchesTable,
  capsuleOperationsTable,
  capsulesTable,
  type CapsuleDestroyReceipt,
  type CapsuleHostDbContract,
  type CapsuleOperationRequestHash,
  type CapsuleOperationStatusValue,
} from '@qiln/core/server'
import { IncusError, isUniqueConstraintViolation } from '../../../../../errors'
import {
  assertOperationReplayIdentity,
  toCapsuleLifecycleState,
  toCapsuleOperationTransition,
  type CapsuleOperationReader,
  type PersistedCapsuleOperation,
} from '../../shared'
import { assertOfflineDestroyCapsuleBranchLineage } from '../policy/lineage'
import { lockDestroyCapsuleBranches, lockOwnedDestroyCapsule } from './locks'
import type { AcceptDestroyCapsuleOperationInput, DestroyCapsuleRepositoryResult } from '../types'

/**
 * Owns durable destroy acceptance and replay.
 *
 * The complete acceptance transaction covers:
 *
 * - capsule and branch locking;
 * - lifecycle and lineage eligibility;
 * - operation insertion;
 * - capsule and branch mutation fences;
 * - committed receipt and invalidation-source mapping.
 *
 * The replay lookup after a uniqueness violation closes the concurrent
 * acceptance race without weakening idempotency identity validation.
 */
export class DestroyCapsuleAcceptancePersistence {
  constructor(
    private readonly db: CapsuleHostDbContract,
    private readonly reader: CapsuleOperationReader,
  ) {}

  public async acceptOrReplay(input: AcceptDestroyCapsuleOperationInput): Promise<DestroyCapsuleRepositoryResult> {
    const replay = await this.findSubmissionReplay(input.ownerId, input.actor, input.idempotencyKey, input.requestHash)
    if (replay) {
      return replay
    }
    try {
      return await this.db.transaction(async tx => {
        const capsule = await lockOwnedDestroyCapsule(tx, input.ownerId, input.capsuleId)
        if (capsule.lifecycleStatus !== 'active' || capsule.archivedAt === null) {
          throw new IncusError('Capsule must be active and archived before it can be destroyed.', 'CONFLICT', {
            ownerId: input.ownerId,
            capsuleId: input.capsuleId,
            lifecycleStatus: capsule.lifecycleStatus,
            archived: capsule.archivedAt !== null,
          })
        }
        const branches = await lockDestroyCapsuleBranches(tx, input.capsuleId)

        assertOfflineDestroyCapsuleBranchLineage(input.ownerId, input.capsuleId, branches)

        const now = new Date()
        const [operation] = await tx
          .insert(capsuleOperationsTable)
          .values({
            ownerId: input.ownerId,
            actorType: input.actor.type,
            actorId: input.actor.id,
            capsuleId: input.capsuleId,
            branchId: null,
            type: CapsuleOperationType.DESTROY,
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
            branchId: capsuleOperationsTable.branchId,
            status: capsuleOperationsTable.status,
          })

        if (!operation) {
          throw new IncusError('Failed to durably accept the capsule destroy operation.', 'API_ERROR')
        }
        if (operation.branchId !== null) {
          throw new IncusError('Accepted capsule destroy operation unexpectedly references one branch.', 'CONFLICT', {
            operationId: operation.id,
            branchId: operation.branchId,
          })
        }
        const [destroyingCapsule] = await tx
          .update(capsulesTable)
          .set({
            lifecycleStatus: 'destroying',
            updatedAt: now,
          })
          .where(
            and(
              eq(capsulesTable.id, input.capsuleId),
              eq(capsulesTable.ownerId, input.ownerId),
              eq(capsulesTable.lifecycleStatus, 'active'),
              isNotNull(capsulesTable.archivedAt),
            ),
          )
          .returning({
            lifecycleStatus: capsulesTable.lifecycleStatus,
            archivedAt: capsulesTable.archivedAt,
            destroyedAt: capsulesTable.destroyedAt,
          })
        if (!destroyingCapsule || destroyingCapsule.archivedAt === null) {
          throw new IncusError('Failed to transition the capsule into its destroy mutation fence.', 'CONFLICT', {
            ownerId: input.ownerId,
            capsuleId: input.capsuleId,
          })
        }
        const transitionedBranches = await tx
          .update(capsuleBranchesTable)
          .set({
            status: 'destroying',
            runtimeIp: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(capsuleBranchesTable.capsuleId, input.capsuleId),
              eq(capsuleBranchesTable.ownerId, input.ownerId),
              eq(capsuleBranchesTable.status, 'offline'),
            ),
          )
          .returning({
            id: capsuleBranchesTable.id,
            capsuleId: capsuleBranchesTable.capsuleId,
            name: capsuleBranchesTable.name,
            status: capsuleBranchesTable.status,
          })
        if (transitionedBranches.length !== branches.length) {
          throw new IncusError('Failed to transition every capsule branch into the destroy mutation fence.', 'CONFLICT', {
            ownerId: input.ownerId,
            capsuleId: input.capsuleId,
            expectedBranchCount: branches.length,
            transitionedBranchCount: transitionedBranches.length,
          })
        }
        return {
          newlyAccepted: true,
          receipt: this.createReceipt({
            operationId: operation.id,
            capsuleId: operation.capsuleId,
            operationStatus: operation.status,
            replayed: false,
          }),
          operation: toCapsuleOperationTransition({
            ownerId: operation.ownerId,
            operationId: operation.id,
            operationType: CapsuleOperationType.DESTROY,
            operationStatus: operation.status,
            capsuleId: operation.capsuleId,
            branchId: null,
          }),
          capsule: toCapsuleLifecycleState({
            capsuleId: operation.capsuleId,
            lifecycleStatus: destroyingCapsule.lifecycleStatus,
            archivedAt: destroyingCapsule.archivedAt,
            destroyedAt: destroyingCapsule.destroyedAt,
          }),
          branches: transitionedBranches,
        }
      })
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error
      }
      const racedReplay = await this.findSubmissionReplay(input.ownerId, input.actor, input.idempotencyKey, input.requestHash)
      if (racedReplay) {
        return racedReplay
      }
      throw new IncusError('Capsule destroy conflicts with another durable capsule operation.', 'CONFLICT', {
        ownerId: input.ownerId,
        capsuleId: input.capsuleId,
      })
    }
  }

  private async findSubmissionReplay(
    ownerId: string,
    actor: AcceptDestroyCapsuleOperationInput['actor'],
    idempotencyKey: string,
    requestHash: CapsuleOperationRequestHash,
  ): Promise<DestroyCapsuleRepositoryResult | null> {
    const operation = await this.reader.loadByOwnerAndIdempotencyKey(ownerId, idempotencyKey)
    if (!operation) {
      return null
    }

    assertOperationReplayIdentity(operation, {
      actor,
      operationType: CapsuleOperationType.DESTROY,
      requestHash,
      requestDescription: 'capsule destroy',
    })

    return await this.loadAcceptanceResult(operation, false, true)
  }

  private async loadAcceptanceResult(
    operation: PersistedCapsuleOperation,
    newlyAccepted: boolean,
    replayed: boolean,
  ): Promise<DestroyCapsuleRepositoryResult> {
    if (operation.branchId !== null) {
      throw new IncusError('Capsule destroy operation unexpectedly references one branch.', 'CONFLICT', {
        operationId: operation.id,
        branchId: operation.branchId,
      })
    }
    const [capsule] = await this.db
      .select({
        lifecycleStatus: capsulesTable.lifecycleStatus,
        archivedAt: capsulesTable.archivedAt,
        destroyedAt: capsulesTable.destroyedAt,
      })
      .from(capsulesTable)
      .where(and(eq(capsulesTable.id, operation.capsuleId), eq(capsulesTable.ownerId, operation.ownerId)))
      .limit(1)
    if (!capsule) {
      throw new IncusError('Capsule destroy operation references a missing capsule aggregate.', 'API_ERROR', {
        operationId: operation.id,
        capsuleId: operation.capsuleId,
      })
    }
    const branches = await this.db
      .select({
        id: capsuleBranchesTable.id,
        capsuleId: capsuleBranchesTable.capsuleId,
        name: capsuleBranchesTable.name,
        status: capsuleBranchesTable.status,
      })
      .from(capsuleBranchesTable)
      .where(and(eq(capsuleBranchesTable.capsuleId, operation.capsuleId), eq(capsuleBranchesTable.ownerId, operation.ownerId)))
      .orderBy(asc(capsuleBranchesTable.id))
    return {
      newlyAccepted,
      receipt: this.createReceipt({
        operationId: operation.id,
        capsuleId: operation.capsuleId,
        operationStatus: operation.status,
        replayed,
      }),
      operation: toCapsuleOperationTransition({
        ownerId: operation.ownerId,
        operationId: operation.id,
        operationType: CapsuleOperationType.DESTROY,
        operationStatus: operation.status,
        capsuleId: operation.capsuleId,
        branchId: null,
      }),
      capsule: toCapsuleLifecycleState({
        capsuleId: operation.capsuleId,
        lifecycleStatus: capsule.lifecycleStatus,
        archivedAt: capsule.archivedAt,
        destroyedAt: capsule.destroyedAt,
      }),
      branches,
    }
  }

  private createReceipt(input: {
    operationId: string
    capsuleId: string
    operationStatus: CapsuleOperationStatusValue
    replayed: boolean
  }): CapsuleDestroyReceipt {
    return CapsuleDestroyReceiptSchema.parse({
      operationId: input.operationId,
      operationType: CapsuleOperationType.DESTROY,
      operationStatus: input.operationStatus,
      capsuleId: input.capsuleId,
      replayed: input.replayed,
    })
  }
}
