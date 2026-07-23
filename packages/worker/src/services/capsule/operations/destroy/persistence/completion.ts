import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  capsuleBranchesTable,
  capsuleOperationsTable,
  capsuleSnapshotsTable,
  capsulesTable,
  type CapsuleHostDbContract,
} from '@qiln/core/server'
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
export async function completeDestroyCapsule(
  db: CapsuleHostDbContract,
  operationId: string,
): Promise<DestroyCapsuleTerminalResult> {
  return await db.transaction(async tx => {
    const operation = await lockDestroyOperation(tx, operationId)
    if (operation.status !== CapsuleOperationStatus.RUNNING || operation.providerMutationStartedAt === null) {
      throw new IncusError('Capsule destroy operation is not eligible for successful completion.', 'CONFLICT', {
        operationId,
        operationStatus: operation.status,
        hasProviderIntent: operation.providerMutationStartedAt !== null,
      })
    }
    const capsule = await lockOwnedDestroyCapsule(tx, operation.ownerId, operation.capsuleId)
    const branches = await lockDestroyCapsuleBranches(tx, operation.capsuleId)

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
        id: capsuleSnapshotsTable.id,
        mode: capsuleSnapshotsTable.mode,
      })
      .from(capsuleSnapshotsTable)
      .where(and(eq(capsuleSnapshotsTable.capsuleId, operation.capsuleId), isNull(capsuleSnapshotsTable.archivedAt)))
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
    const resources = await lockDestroyBranchResourceInventories(
      tx,
      branches.map(branch => branch.id),
    )

    planner.assertTerminalResourceOutcomes(operation.ownerId, operation.capsuleId, branches, resources, operation.id)

    const now = new Date()
    const [completedOperation] = await tx
      .update(capsuleOperationsTable)
      .set({
        status: CapsuleOperationStatus.COMPLETED,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleOperationsTable.id, operationId),
          eq(capsuleOperationsTable.type, CapsuleOperationType.DESTROY),
          eq(capsuleOperationsTable.status, CapsuleOperationStatus.RUNNING),
          isNotNull(capsuleOperationsTable.providerMutationStartedAt),
        ),
      )
      .returning({
        id: capsuleOperationsTable.id,
      })
    const [destroyedCapsule] = await tx
      .update(capsulesTable)
      .set({
        lifecycleStatus: 'destroyed',
        destroyedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(capsulesTable.id, operation.capsuleId),
          eq(capsulesTable.ownerId, operation.ownerId),
          eq(capsulesTable.lifecycleStatus, 'destroying'),
          isNotNull(capsulesTable.archivedAt),
        ),
      )
      .returning({
        lifecycleStatus: capsulesTable.lifecycleStatus,
        archivedAt: capsulesTable.archivedAt,
        destroyedAt: capsulesTable.destroyedAt,
      })
    const destroyedBranches = await tx
      .update(capsuleBranchesTable)
      .set({
        status: 'destroyed',
        runtimeIp: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleBranchesTable.capsuleId, operation.capsuleId),
          eq(capsuleBranchesTable.ownerId, operation.ownerId),
          eq(capsuleBranchesTable.status, 'destroying'),
        ),
      )
      .returning({
        id: capsuleBranchesTable.id,
        capsuleId: capsuleBranchesTable.capsuleId,
        name: capsuleBranchesTable.name,
        status: capsuleBranchesTable.status,
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
