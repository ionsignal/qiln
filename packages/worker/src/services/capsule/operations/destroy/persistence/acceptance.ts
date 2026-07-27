import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm'
import {
  CapsuleDestroyReceiptSchema,
  CapsuleOperationStatus,
  CapsuleOperationType,
  type CapsuleDestroyReceipt,
  type CapsuleOperationRequestHash,
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
import { assertOfflineDestroyCapsuleBranchLineage } from '../policy/lineage'
import { lockDestroyCapsuleBranches, lockOwnedDestroyCapsule } from './locks'
import type { AcceptDestroyCapsuleOperationInput, DestroyCapsuleRepositoryResult } from '../types'

/**
 * Owns durable destroy acceptance and replay.
 *
 * The complete acceptance transaction covers:
 *
 * - Capsule and branch locking;
 * - Lifecycle and lineage eligibility;
 * - Retained committed-snapshot protection;
 * - Operation insertion;
 * - Capsule and branch mutation fences;
 * - Committed receipt and invalidation-source mapping.
 *
 * The replay lookup after a uniqueness violation closes the concurrent
 * acceptance race without weakening idempotency identity validation.
 */
export class DestroyCapsuleAcceptancePersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly reader: CapsuleOperationReader<TDatabase, TTables>,
  ) {}

  public async acceptOrReplay(input: AcceptDestroyCapsuleOperationInput): Promise<DestroyCapsuleRepositoryResult> {
    const replay = await this.findSubmissionReplay(input.ownerId, input.actor, input.idempotencyKey, input.requestHash)
    if (replay) {
      return replay
    }
    const db = this.persistence.db
    const { capsules, capsuleBranches, capsuleOperations, capsuleSnapshots } = this.persistence.tables
    try {
      return await db.transaction(async tx => {
        const capsule = await lockOwnedDestroyCapsule<TDatabase, TTables>(
          tx,
          this.persistence.tables,
          input.ownerId,
          input.capsuleId,
        )
        if (capsule.lifecycleStatus !== 'active' || capsule.archivedAt === null) {
          throw new IncusError('Capsule must be active and archived before it can be destroyed.', 'CONFLICT', {
            ownerId: input.ownerId,
            capsuleId: input.capsuleId,
            lifecycleStatus: capsule.lifecycleStatus,
            archived: capsule.archivedAt !== null,
          })
        }

        /**
         * Experimental committed snapshots retain provider snapshots attached
         * to branch storage. Destroy must fail closed until snapshot archival
         * and provider-retention deletion are implemented.
         *
         * The capsule row lock serializes this check with Snapshot Capture's
         * atomic commit transaction.
         */
        const [retainedSnapshot] = await tx
          .select({
            id: capsuleSnapshots.id,
            mode: capsuleSnapshots.mode,
          })
          .from(capsuleSnapshots)
          .where(and(eq(capsuleSnapshots.capsuleId, input.capsuleId), isNull(capsuleSnapshots.archivedAt)))
          .limit(1)
        if (retainedSnapshot) {
          throw new IncusError('Capsule cannot be destroyed while it has retained committed snapshots.', 'CONFLICT', {
            ownerId: input.ownerId,
            capsuleId: input.capsuleId,
            snapshotId: retainedSnapshot.id,
            snapshotMode: retainedSnapshot.mode,
            policy: 'snapshot_retention_deletion_not_implemented',
          })
        }
        const branches = await lockDestroyCapsuleBranches<TDatabase, TTables>(
          tx,
          this.persistence.tables,
          input.capsuleId,
        )

        assertOfflineDestroyCapsuleBranchLineage(input.ownerId, input.capsuleId, branches)

        const now = new Date()
        const [operation] = await tx
          .insert(capsuleOperations)
          .values({
            ownerId: input.ownerId,
            actorType: input.actor.type,
            actorId: input.actor.id,
            capsuleId: input.capsuleId,
            type: CapsuleOperationType.DESTROY,
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
          throw new IncusError('Failed to durably accept the capsule destroy operation.', 'API_ERROR')
        }
        const [destroyingCapsule] = await tx
          .update(capsules)
          .set({
            lifecycleStatus: 'destroying',
            updatedAt: now,
          })
          .where(
            and(
              eq(capsules.id, input.capsuleId),
              eq(capsules.ownerId, input.ownerId),
              eq(capsules.lifecycleStatus, 'active'),
              isNotNull(capsules.archivedAt),
            ),
          )
          .returning({
            lifecycleStatus: capsules.lifecycleStatus,
            archivedAt: capsules.archivedAt,
            destroyedAt: capsules.destroyedAt,
          })
        if (!destroyingCapsule || destroyingCapsule.archivedAt === null) {
          throw new IncusError('Failed to transition the capsule into its destroy mutation fence.', 'CONFLICT', {
            ownerId: input.ownerId,
            capsuleId: input.capsuleId,
          })
        }
        const transitionedBranches = await tx
          .update(capsuleBranches)
          .set({
            status: 'destroying',
            runtimeIp: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(capsuleBranches.capsuleId, input.capsuleId),
              eq(capsuleBranches.ownerId, input.ownerId),
              eq(capsuleBranches.status, 'offline'),
            ),
          )
          .returning({
            id: capsuleBranches.id,
            capsuleId: capsuleBranches.capsuleId,
            name: capsuleBranches.name,
            status: capsuleBranches.status,
          })
        if (transitionedBranches.length !== branches.length) {
          throw new IncusError(
            'Failed to transition every capsule branch into the destroy mutation fence.',
            'CONFLICT',
            {
              ownerId: input.ownerId,
              capsuleId: input.capsuleId,
              expectedBranchCount: branches.length,
              transitionedBranchCount: transitionedBranches.length,
            },
          )
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
      const racedReplay = await this.findSubmissionReplay(
        input.ownerId,
        input.actor,
        input.idempotencyKey,
        input.requestHash,
      )
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
    const db = this.persistence.db
    const { capsules, capsuleBranches } = this.persistence.tables
    const [capsule] = await db
      .select({
        lifecycleStatus: capsules.lifecycleStatus,
        archivedAt: capsules.archivedAt,
        destroyedAt: capsules.destroyedAt,
      })
      .from(capsules)
      .where(and(eq(capsules.id, operation.capsuleId), eq(capsules.ownerId, operation.ownerId)))
      .limit(1)

    if (!capsule) {
      throw new IncusError('Capsule destroy operation references a missing capsule aggregate.', 'API_ERROR', {
        operationId: operation.id,
        capsuleId: operation.capsuleId,
      })
    }
    const branches = await db
      .select({
        id: capsuleBranches.id,
        capsuleId: capsuleBranches.capsuleId,
        name: capsuleBranches.name,
        status: capsuleBranches.status,
      })
      .from(capsuleBranches)
      .where(and(eq(capsuleBranches.capsuleId, operation.capsuleId), eq(capsuleBranches.ownerId, operation.ownerId)))
      .orderBy(asc(capsuleBranches.id))
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
