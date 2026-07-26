import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { CapsuleOperationStatus, CapsuleOperationType, type QilnPersistence, type QilnTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError } from '../../../../../errors'
import { toCapsuleLifecycleState, toCapsuleOperationTransition } from '../../shared'
import { assertDestroyingCapsuleBranchLineage } from '../policy/lineage'
import { DestroyCapsulePlanner } from '../resource/planner'
import {
  lockDestroyBranchResourceInventories,
  lockDestroyCapsuleBranches,
  lockDestroyOperation,
  lockOwnedDestroyCapsule,
} from './locks'
import type { DestroyCapsuleTerminalResult } from '../types'

const planner = new DestroyCapsulePlanner()

/**
 * Atomically commits terminal capsule destruction.
 *
 * The transaction independently proves all durable completion evidence:
 *
 * - Operation identity and running state;
 * - Committed provider intent;
 * - Capsule ownership and destroy lifecycle fence;
 * - Absence of retained committed snapshots;
 * - The complete destroying branch lineage;
 * - Each branch's immutable resource inventory digest;
 * - Resource ownership, topology, cleanup policy, and provenance;
 * - Terminal direct-resource and derived-resource outcomes;
 * - Compare-and-set predicates for operation, capsule, and branch completion.
 *
 * Process-local plans and earlier executor verification are deliberately not
 * accepted as completion authority. Resource rows are locked and revalidated in
 * the same transaction that commits terminal aggregate state.
 */
export async function completeDestroyCapsule<TDatabase extends PostgresJsDatabase, TTables extends QilnTables>(
  persistence: QilnPersistence<TDatabase, TTables>,
  operationId: string,
): Promise<DestroyCapsuleTerminalResult> {
  const db = persistence.db
  const { capsules, capsuleBranches, capsuleOperations, capsuleSnapshots } = persistence.tables
  return await db.transaction(async tx => {
    const operation = await lockDestroyOperation<TDatabase, TTables>(tx, persistence.tables, operationId)
    if (operation.status !== CapsuleOperationStatus.RUNNING || operation.providerMutationStartedAt === null) {
      throw new IncusError('Capsule destroy operation is not eligible for successful completion.', 'CONFLICT', {
        operationId,
        operationStatus: operation.status,
        hasProviderIntent: operation.providerMutationStartedAt !== null,
      })
    }
    const capsule = await lockOwnedDestroyCapsule<TDatabase, TTables>(
      tx,
      persistence.tables,
      operation.ownerId,
      operation.capsuleId,
    )
    const branches = await lockDestroyCapsuleBranches<TDatabase, TTables>(tx, persistence.tables, operation.capsuleId)

    assertDestroyingCapsuleBranchLineage(operation.ownerId, operation.capsuleId, branches)

    if (capsule.lifecycleStatus !== 'destroying' || capsule.archivedAt === null) {
      throw new IncusError('Capsule aggregate is not eligible for terminal destroy completion.', 'CONFLICT', {
        operationId,
        capsuleId: operation.capsuleId,
        lifecycleStatus: capsule.lifecycleStatus,
        archived: capsule.archivedAt !== null,
      })
    }

    /**
     * Revalidate retained snapshot absence inside terminal completion.
     *
     * Acceptance performs the same check before any provider mutation. This
     * second check makes terminal storage retirement fail closed if durable
     * snapshot state is introduced unexpectedly or future concurrency policy
     * changes weaken the current capsule-wide operation fence.
     */
    const [retainedSnapshot] = await tx
      .select({
        id: capsuleSnapshots.id,
        mode: capsuleSnapshots.mode,
      })
      .from(capsuleSnapshots)
      .where(and(eq(capsuleSnapshots.capsuleId, operation.capsuleId), isNull(capsuleSnapshots.archivedAt)))
      .limit(1)
    if (retainedSnapshot) {
      throw new IncusError(
        'Capsule destroy cannot complete while a committed snapshot retains provider storage.',
        'CONFLICT',
        {
          operationId,
          capsuleId: operation.capsuleId,
          snapshotId: retainedSnapshot.id,
          snapshotMode: retainedSnapshot.mode,
          policy: 'snapshot_retention_deletion_not_implemented',
        },
      )
    }
    const resources = await lockDestroyBranchResourceInventories<TDatabase, TTables>(
      tx,
      persistence.tables,
      branches.map(branch => branch.id),
    )

    planner.assertTerminalResourceOutcomes(operation.ownerId, operation.capsuleId, branches, resources, operation.id)

    const now = new Date()
    const [completedOperation] = await tx
      .update(capsuleOperations)
      .set({
        status: CapsuleOperationStatus.COMPLETED,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleOperations.id, operationId),
          eq(capsuleOperations.type, CapsuleOperationType.DESTROY),
          eq(capsuleOperations.status, CapsuleOperationStatus.RUNNING),
          isNotNull(capsuleOperations.providerMutationStartedAt),
        ),
      )
      .returning({
        id: capsuleOperations.id,
      })
    const [destroyedCapsule] = await tx
      .update(capsules)
      .set({
        lifecycleStatus: 'destroyed',
        destroyedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(capsules.id, operation.capsuleId),
          eq(capsules.ownerId, operation.ownerId),
          eq(capsules.lifecycleStatus, 'destroying'),
          isNotNull(capsules.archivedAt),
        ),
      )
      .returning({
        lifecycleStatus: capsules.lifecycleStatus,
        archivedAt: capsules.archivedAt,
        destroyedAt: capsules.destroyedAt,
      })
    const destroyedBranches = await tx
      .update(capsuleBranches)
      .set({
        status: 'destroyed',
        runtimeIp: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleBranches.capsuleId, operation.capsuleId),
          eq(capsuleBranches.ownerId, operation.ownerId),
          eq(capsuleBranches.status, 'destroying'),
        ),
      )
      .returning({
        id: capsuleBranches.id,
        capsuleId: capsuleBranches.capsuleId,
        name: capsuleBranches.name,
        status: capsuleBranches.status,
      })
    if (
      !completedOperation ||
      !destroyedCapsule ||
      destroyedCapsule.destroyedAt === null ||
      destroyedBranches.length !== branches.length
    ) {
      throw new IncusError('Failed to atomically complete capsule destroy.', 'CONFLICT', {
        operationId,
        capsuleId: operation.capsuleId,
        expectedBranchCount: branches.length,
        destroyedBranchCount: destroyedBranches.length,
      })
    }
    return {
      operation: toCapsuleOperationTransition({
        ownerId: operation.ownerId,
        operationId,
        operationType: CapsuleOperationType.DESTROY,
        operationStatus: CapsuleOperationStatus.COMPLETED,
        capsuleId: operation.capsuleId,
      }),
      capsule: toCapsuleLifecycleState({
        capsuleId: operation.capsuleId,
        lifecycleStatus: destroyedCapsule.lifecycleStatus,
        archivedAt: destroyedCapsule.archivedAt,
        destroyedAt: destroyedCapsule.destroyedAt,
      }),
      branches: destroyedBranches,
    }
  })
}
