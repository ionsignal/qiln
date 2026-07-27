import { and, asc, eq, inArray } from 'drizzle-orm'
import { CapsuleOperationType, type CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError } from '../../../../../errors'
import type { CapsuleBranchResourceInventoryRow } from '../../../resource/types'
import type { DestroyCapsuleAcceptedBranch } from '../types'

export type PersistedDestroyOperation = CapsuleTables['capsuleOperations']['$inferSelect']
export type PersistedDestroyCapsule = CapsuleTables['capsules']['$inferSelect']

/**
 * Locks one destroy operation inside an existing transaction.
 *
 * This helper owns only the mechanical row-lock query and operation-type
 * identity check. The caller remains responsible for operation status,
 * provider-intent, lifecycle, and terminal-classification policy.
 */
export async function lockDestroyOperation<TDatabase extends PostgresJsDatabase, TTables extends CapsuleTables>(
  tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
  tables: TTables,
  operationId: string,
): Promise<PersistedDestroyOperation> {
  const operations = tables.capsuleOperations
  const [operation] = await tx
    .select()
    .from(operations)
    .where(and(eq(operations.id, operationId), eq(operations.type, CapsuleOperationType.DESTROY)))
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
export async function lockOwnedDestroyCapsule<TDatabase extends PostgresJsDatabase, TTables extends CapsuleTables>(
  tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
  tables: TTables,
  ownerId: string,
  capsuleId: string,
): Promise<PersistedDestroyCapsule> {
  const capsules = tables.capsules
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

/**
 * Locks every durable branch belonging to one capsule in deterministic ID
 * order.
 *
 * Owner and lifecycle consistency are intentionally left to the caller because
 * contradictory branch evidence must be available to operation-specific
 * fail-closed policy.
 */
export async function lockDestroyCapsuleBranches<TDatabase extends PostgresJsDatabase, TTables extends CapsuleTables>(
  tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
  tables: TTables,
  capsuleId: string,
): Promise<DestroyCapsuleAcceptedBranch[]> {
  const branches = tables.capsuleBranches
  return await tx
    .select({
      id: branches.id,
      capsuleId: branches.capsuleId,
      ownerId: branches.ownerId,
      name: branches.name,
      status: branches.status,
      isRootBranch: branches.isRootBranch,
      resourceInventoryDigest: branches.resourceInventoryDigest,
    })
    .from(branches)
    .where(eq(branches.capsuleId, capsuleId))
    .orderBy(asc(branches.id))
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
export async function lockDestroyBranchResourceInventories<
  TDatabase extends PostgresJsDatabase,
  TTables extends CapsuleTables,
>(
  tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
  tables: TTables,
  branchIds: readonly string[],
): Promise<CapsuleBranchResourceInventoryRow[]> {
  if (branchIds.length === 0) {
    return []
  }
  const resources = tables.capsuleBranchResources
  return await tx
    .select({
      id: resources.id,
      ownerId: resources.ownerId,
      branchId: resources.branchId,
      branchName: resources.branchName,
      provider: resources.provider,
      resourceType: resources.resourceType,
      resourceKey: resources.resourceKey,
      blueprintVolumeName: resources.blueprintVolumeName,
      status: resources.status,
      cleanupPolicy: resources.cleanupPolicy,
      metadata: resources.metadata,
      createdByOperationId: resources.createdByOperationId,
      lastOperationId: resources.lastOperationId,
    })
    .from(resources)
    .where(inArray(resources.branchId, [...branchIds]))
    .orderBy(asc(resources.branchId), asc(resources.createdAt), asc(resources.id))
    .for('update')
}
