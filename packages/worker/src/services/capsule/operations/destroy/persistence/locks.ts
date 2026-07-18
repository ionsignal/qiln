import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  CapsuleOperationType,
  capsuleBranchesTable,
  capsuleBranchResourcesTable,
  capsuleOperationsTable,
  capsulesTable,
  type CapsuleHostDbContract,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import type { CapsuleBranchResourceInventoryRow } from '../../../resource/types'
import type { DestroyCapsuleAcceptedBranch } from '../types'

export type DestroyOperationTransaction = Parameters<Parameters<CapsuleHostDbContract['transaction']>[0]>[0]
export type PersistedDestroyOperation = typeof capsuleOperationsTable.$inferSelect
export type PersistedDestroyCapsule = typeof capsulesTable.$inferSelect

/**
 * Locks one destroy operation inside an existing transaction.
 *
 * This helper owns only the mechanical row-lock query and operation-type
 * identity check. The caller remains responsible for operation status,
 * provider-intent, lifecycle, and terminal-classification policy.
 */
export async function lockDestroyOperation(tx: DestroyOperationTransaction, operationId: string): Promise<PersistedDestroyOperation> {
  const [operation] = await tx
    .select()
    .from(capsuleOperationsTable)
    .where(and(eq(capsuleOperationsTable.id, operationId), eq(capsuleOperationsTable.type, CapsuleOperationType.DESTROY)))
    .for('update')
    .limit(1)
  if (!operation) {
    throw new IncusError('Capsule destroy operation was not found.', 'NOT_FOUND', {
      operationId,
    })
  }
  return operation
}

/**
 * Locks one owner-scoped capsule inside an existing transaction.
 *
 * The query enforces aggregate ownership but makes no lifecycle decision.
 */
export async function lockOwnedDestroyCapsule(
  tx: DestroyOperationTransaction,
  ownerId: string,
  capsuleId: string,
): Promise<PersistedDestroyCapsule> {
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

/**
 * Locks every durable branch belonging to one capsule in deterministic ID
 * order.
 *
 * Owner and lifecycle consistency are intentionally left to the caller because
 * contradictory branch evidence must be available to operation-specific
 * fail-closed policy.
 */
export async function lockDestroyCapsuleBranches(tx: DestroyOperationTransaction, capsuleId: string): Promise<DestroyCapsuleAcceptedBranch[]> {
  return await tx
    .select({
      id: capsuleBranchesTable.id,
      capsuleId: capsuleBranchesTable.capsuleId,
      ownerId: capsuleBranchesTable.ownerId,
      name: capsuleBranchesTable.name,
      status: capsuleBranchesTable.status,
      isRootBranch: capsuleBranchesTable.isRootBranch,
      resourceInventoryDigest: capsuleBranchesTable.resourceInventoryDigest,
    })
    .from(capsuleBranchesTable)
    .where(eq(capsuleBranchesTable.capsuleId, capsuleId))
    .orderBy(asc(capsuleBranchesTable.id))
    .for('update')
}

/**
 * Locks the complete durable resource inventory currently attached to a set of
 * capsule branches.
 *
 * Completion uses this after locking the operation, capsule, and branch
 * lineage. The returned rows are ordered deterministically so concurrent
 * persistence paths cannot acquire the same inventory in an arbitrary order.
 *
 * This helper does not validate ownership, inventory completeness, cleanup
 * policy, terminal status, or operation provenance. Those decisions remain in
 * the destroy planner's fail-closed durable-evidence policy.
 */
export async function lockDestroyBranchResourceInventories(
  tx: DestroyOperationTransaction,
  branchIds: readonly string[],
): Promise<CapsuleBranchResourceInventoryRow[]> {
  if (branchIds.length === 0) {
    return []
  }
  return await tx
    .select({
      id: capsuleBranchResourcesTable.id,
      ownerId: capsuleBranchResourcesTable.ownerId,
      branchId: capsuleBranchResourcesTable.branchId,
      branchName: capsuleBranchResourcesTable.branchName,
      provider: capsuleBranchResourcesTable.provider,
      resourceType: capsuleBranchResourcesTable.resourceType,
      resourceKey: capsuleBranchResourcesTable.resourceKey,
      status: capsuleBranchResourcesTable.status,
      cleanupPolicy: capsuleBranchResourcesTable.cleanupPolicy,
      metadata: capsuleBranchResourcesTable.metadata,
      createdByOperationId: capsuleBranchResourcesTable.createdByOperationId,
      lastOperationId: capsuleBranchResourcesTable.lastOperationId,
    })
    .from(capsuleBranchResourcesTable)
    .where(inArray(capsuleBranchResourcesTable.branchId, [...branchIds]))
    .orderBy(asc(capsuleBranchResourcesTable.branchId), asc(capsuleBranchResourcesTable.createdAt), asc(capsuleBranchResourcesTable.id))
    .for('update')
}
