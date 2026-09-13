import { and, asc, eq } from 'drizzle-orm'
import { IncusError } from '../../../../../errors'
import type { CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { DestroyBranch, DestroyCapsule, DestroyOperation } from '../types'

export type DestroyTransaction<TDatabase extends PostgresJsDatabase> = Parameters<
  Parameters<TDatabase['transaction']>[0]
>[0]

/**
 * Locks the capsule before any descendant destroy evidence.
 *
 * Ownership is checked after selecting the exact aggregate identity so a
 * contradictory operation cannot silently redirect the lock.
 */
export async function lockCapsule<TDatabase extends PostgresJsDatabase>(
  tx: DestroyTransaction<TDatabase>,
  tables: CapsuleTables,
  ownerId: string,
  capsuleId: string,
): Promise<DestroyCapsule> {
  const [capsule] = await tx
    .select()
    .from(tables.capsules)
    .where(and(eq(tables.capsules.id, capsuleId), eq(tables.capsules.ownerId, ownerId)))
    .for('update')
    .limit(1)
  if (!capsule) {
    throw new IncusError('Capsule not found or access denied.', 'NOT_FOUND')
  }
  return capsule
}

/**
 * Discovers the parent without locking descendants, then revalidates the
 * operation under capsule-first locks.
 */
export async function lockOperation<TDatabase extends PostgresJsDatabase>(
  tx: DestroyTransaction<TDatabase>,
  tables: CapsuleTables,
  operationId: string,
): Promise<{ operation: DestroyOperation; capsule: DestroyCapsule }> {
  const operations = tables.capsuleOperations
  const [identity] = await tx
    .select({
      ownerId: operations.ownerId,
      capsuleId: operations.capsuleId,
      type: operations.type,
    })
    .from(operations)
    .where(eq(operations.id, operationId))
    .limit(1)
  if (!identity || identity.type !== 'destroy') {
    throw new IncusError('Capsule destroy operation was not found.', 'NOT_FOUND')
  }
  const capsule = await lockCapsule<TDatabase>(tx, tables, identity.ownerId, identity.capsuleId)
  const [operation] = await tx
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.id, operationId),
        eq(operations.type, 'destroy'),
        eq(operations.ownerId, identity.ownerId),
        eq(operations.capsuleId, identity.capsuleId),
      ),
    )
    .for('update')
    .limit(1)
  if (!operation) {
    throw new IncusError('Destroy identity changed while acquiring its parent lock.', 'CONFLICT')
  }
  return { operation, capsule }
}

/**
 * Includes every branch attributed to the capsule so ownership contradictions
 * remain visible to destroy policy.
 */
export async function lockBranches<TDatabase extends PostgresJsDatabase>(
  tx: DestroyTransaction<TDatabase>,
  tables: CapsuleTables,
  capsuleId: string,
): Promise<DestroyBranch[]> {
  return await tx
    .select()
    .from(tables.capsuleBranches)
    .where(eq(tables.capsuleBranches.capsuleId, capsuleId))
    .orderBy(asc(tables.capsuleBranches.id))
    .for('update')
}
