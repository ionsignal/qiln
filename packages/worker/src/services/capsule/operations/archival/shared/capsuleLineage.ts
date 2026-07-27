import { and, asc, eq } from 'drizzle-orm'
import { IncusError } from '../../../../../errors'
import type { CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

export type ArchivalCapsuleRecord = Pick<
  CapsuleTables['capsules']['$inferSelect'],
  'id' | 'ownerId' | 'lifecycleStatus' | 'archivedAt' | 'destroyedAt'
>

export type ArchivalBranchRecord = Pick<
  CapsuleTables['capsuleBranches']['$inferSelect'],
  'id' | 'capsuleId' | 'ownerId' | 'name' | 'status' | 'isRootBranch'
>

export interface OfflineBranchLineageBranchDescription {
  branchId: string
  capsuleId: string
  ownerId: string
  branchName: string
  status: ArchivalBranchRecord['status']
  isRootBranch: boolean
}

export interface OfflineBranchLineageInspection {
  valid: boolean
  branchCount: number
  rootBranchCount: number
  branches: OfflineBranchLineageBranchDescription[]
}

/**
 * Reads one owner-scoped capsule without acquiring a row lock.
 *
 * This is intended for replay-result mapping after the operation-specific
 * acceptance transaction has already committed.
 */
export async function readOwnedArchivalCapsule<TDatabase extends PostgresJsDatabase, TTables extends CapsuleTables>(
  persistence: CapsulePersistence<TDatabase, TTables>,
  ownerId: string,
  capsuleId: string,
): Promise<ArchivalCapsuleRecord | null> {
  const db = persistence.db
  const capsules = persistence.tables.capsules
  const [capsule] = await db
    .select({
      id: capsules.id,
      ownerId: capsules.ownerId,
      lifecycleStatus: capsules.lifecycleStatus,
      archivedAt: capsules.archivedAt,
      destroyedAt: capsules.destroyedAt,
    })
    .from(capsules)
    .where(and(eq(capsules.id, capsuleId), eq(capsules.ownerId, ownerId)))
    .limit(1)
  return capsule ?? null
}

/**
 * Locks one owner-scoped capsule inside the caller's operation transaction.
 *
 * The caller owns transaction scope and lifecycle policy. This helper opens no
 * nested transaction and performs no archive or unarchive eligibility checks.
 */
export async function lockOwnedArchivalCapsule<TDatabase extends PostgresJsDatabase, TTables extends CapsuleTables>(
  tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
  tables: TTables,
  ownerId: string,
  capsuleId: string,
): Promise<ArchivalCapsuleRecord> {
  const capsules = tables.capsules
  const [capsule] = await tx
    .select({
      id: capsules.id,
      ownerId: capsules.ownerId,
      lifecycleStatus: capsules.lifecycleStatus,
      archivedAt: capsules.archivedAt,
      destroyedAt: capsules.destroyedAt,
    })
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
 * Owner consistency is validated separately by the lineage inspection because a
 * foreign-owner row attached to the capsule is contradictory durable evidence
 * that operation-specific policy must classify fail-closed.
 */
export async function lockArchivalCapsuleBranches<TDatabase extends PostgresJsDatabase, TTables extends CapsuleTables>(
  tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
  tables: TTables,
  capsuleId: string,
): Promise<ArchivalBranchRecord[]> {
  const branches = tables.capsuleBranches
  return await tx
    .select({
      id: branches.id,
      capsuleId: branches.capsuleId,
      ownerId: branches.ownerId,
      name: branches.name,
      status: branches.status,
      isRootBranch: branches.isRootBranch,
    })
    .from(branches)
    .where(eq(branches.capsuleId, capsuleId))
    .orderBy(asc(branches.id))
    .for('update')
}

/**
 * Produces mechanical evidence about the branch lineage required by
 * provider-free archive and unarchive operations.
 *
 * This does not decide whether invalid evidence rejects acceptance, fails an
 * operation, or requires cleanup. That policy remains in the operation-specific
 * repository.
 */
export function inspectOfflineBranchLineage(
  ownerId: string,
  capsuleId: string,
  branches: readonly ArchivalBranchRecord[],
): OfflineBranchLineageInspection {
  const rootBranchCount = branches.filter(branch => branch.isRootBranch).length
  const valid =
    branches.length > 0 &&
    rootBranchCount === 1 &&
    branches.every(
      branch => branch.ownerId === ownerId && branch.capsuleId === capsuleId && branch.status === 'offline',
    )
  return {
    valid,
    branchCount: branches.length,
    rootBranchCount,
    branches: branches.map(branch => ({
      branchId: branch.id,
      capsuleId: branch.capsuleId,
      ownerId: branch.ownerId,
      branchName: branch.name,
      status: branch.status,
      isRootBranch: branch.isRootBranch,
    })),
  }
}

export function isValidOfflineBranchLineage(
  ownerId: string,
  capsuleId: string,
  branches: readonly ArchivalBranchRecord[],
): boolean {
  return inspectOfflineBranchLineage(ownerId, capsuleId, branches).valid
}

/**
 * Rejects a command-time archival transition when its branch lineage is not
 * exactly one root branch with every branch offline.
 *
 * Terminal failure and abandoned-operation classification should generally use
 * `inspectOfflineBranchLineage()` instead so contradictory evidence can be
 * committed as cleanup-required rather than thrown before terminalization.
 */
export function assertValidOfflineBranchLineage(
  ownerId: string,
  capsuleId: string,
  branches: readonly ArchivalBranchRecord[],
): void {
  const inspection = inspectOfflineBranchLineage(ownerId, capsuleId, branches)
  if (inspection.valid) {
    return
  }
  throw new IncusError(
    'Capsule archival mutation requires exactly one root branch and every branch offline.',
    'CONFLICT',
    {
      ownerId,
      capsuleId,
      branchCount: inspection.branchCount,
      rootBranchCount: inspection.rootBranchCount,
      branches: inspection.branches,
    },
  )
}
