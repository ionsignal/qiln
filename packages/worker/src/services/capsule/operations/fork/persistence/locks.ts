import { asc, eq, or } from 'drizzle-orm'
import { CapsuleOperationType, type CapsulePersistence, type CapsuleTables } from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import type { ForkResourceRecord } from '../types'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

export type ForkTransaction<TDatabase extends PostgresJsDatabase> = Parameters<
  Parameters<TDatabase['transaction']>[0]
>[0]

export interface ForkScope {
  operation: CapsuleTables['capsuleOperations']['$inferSelect']
  capsule: CapsuleTables['capsules']['$inferSelect']
  extension: CapsuleTables['capsuleForkOperations']['$inferSelect'] | null
  branch: CapsuleTables['capsuleBranches']['$inferSelect'] | null
}

/**
 * Serializes fork mutation, replay, and classification through the capsule
 * before locking operation, extension, target branch, or resource rows.
 *
 * Discovery reads identify the parent only. Their identities are revalidated
 * after the parent and operation locks have been acquired.
 */
export class ForkLocks<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly persistence: CapsulePersistence<TDatabase, TTables>) {}

  public async capsule(tx: ForkTransaction<TDatabase>, ownerId: string, capsuleId: string) {
    const capsules = this.persistence.tables.capsules
    const [capsule] = await tx.select().from(capsules).where(eq(capsules.id, capsuleId)).for('update').limit(1)
    if (!capsule || capsule.ownerId !== ownerId) {
      throw new IncusError('Capsule not found or access denied.', 'NOT_FOUND', {
        capsuleId,
      })
    }
    return capsule
  }

  public async scope(tx: ForkTransaction<TDatabase>, operationId: string): Promise<ForkScope> {
    const tables = this.persistence.tables
    const [identity] = await tx
      .select({
        ownerId: tables.capsuleOperations.ownerId,
        capsuleId: tables.capsuleOperations.capsuleId,
        type: tables.capsuleOperations.type,
      })
      .from(tables.capsuleOperations)
      .where(eq(tables.capsuleOperations.id, operationId))
      .limit(1)
    if (!identity || identity.type !== CapsuleOperationType.FORK) {
      throw new IncusError('Capsule fork operation was not found.', 'NOT_FOUND', {
        operationId,
      })
    }
    const capsule = await this.capsule(tx, identity.ownerId, identity.capsuleId)
    const [operation] = await tx
      .select()
      .from(tables.capsuleOperations)
      .where(eq(tables.capsuleOperations.id, operationId))
      .for('update')
      .limit(1)
    if (
      !operation ||
      operation.type !== CapsuleOperationType.FORK ||
      operation.ownerId !== identity.ownerId ||
      operation.capsuleId !== identity.capsuleId
    ) {
      throw new IncusError('Capsule fork identity changed while acquiring its parent locks.', 'CONFLICT', {
        operationId,
      })
    }
    const [extension] = await tx
      .select()
      .from(tables.capsuleForkOperations)
      .where(eq(tables.capsuleForkOperations.operationId, operation.id))
      .for('update')
      .limit(1)
    let branch: ForkScope['branch'] = null
    if (extension) {
      const [target] = await tx
        .select()
        .from(tables.capsuleBranches)
        .where(eq(tables.capsuleBranches.id, extension.targetBranchId))
        .limit(1)
      if (target && target.ownerId === operation.ownerId && target.capsuleId === operation.capsuleId) {
        const [locked] = await tx
          .select()
          .from(tables.capsuleBranches)
          .where(eq(tables.capsuleBranches.id, target.id))
          .for('update')
          .limit(1)
        if (
          !locked ||
          locked.ownerId !== operation.ownerId ||
          locked.capsuleId !== operation.capsuleId ||
          locked.id !== extension.targetBranchId
        ) {
          throw new IncusError('Fork target identity changed while acquiring its branch lock.', 'CONFLICT', {
            operationId,
            branchId: target.id,
          })
        }
        branch = locked
      }
    }
    return {
      operation,
      capsule,
      extension: extension ?? null,
      branch,
    }
  }

  /**
   * Includes operation-attributed rows outside the expected branch so missing
   * or contradictory accounting cannot disappear behind a branch-only filter.
   */
  public async resources(
    tx: ForkTransaction<TDatabase>,
    operationId: string,
    branchId: string,
  ): Promise<ForkResourceRecord[]> {
    const resources = this.persistence.tables.capsuleBranchResources
    return await tx
      .select()
      .from(resources)
      .where(or(eq(resources.createdByOperationId, operationId), eq(resources.branchId, branchId)))
      .orderBy(asc(resources.id))
      .for('update')
  }
}
