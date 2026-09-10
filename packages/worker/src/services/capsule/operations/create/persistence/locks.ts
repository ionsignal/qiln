import { and, asc, eq, inArray, or } from 'drizzle-orm'
import { CapsuleOperationType, type CapsulePersistence, type CapsuleTables } from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

export type CreateTransaction<TDatabase extends PostgresJsDatabase> = Parameters<
  Parameters<TDatabase['transaction']>[0]
>[0]

/**
 * Create-owned locked queries participating in the caller's transaction.
 *
 * Existing-row transactions discover the operation's parent without locking
 * descendants, acquire the capsule lock, and revalidate the operation identity
 * under its row lock before acquiring extension, branch, or resource locks.
 * Reloading the already-locked capsule does not change this parent-first order.
 */
export class CreateCapsuleLocks<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly persistence: CapsulePersistence<TDatabase, TTables>) {}

  public async operation(tx: CreateTransaction<TDatabase>, operationId: string) {
    const operation = await this.optionalOperation(tx, operationId)
    if (!operation) {
      throw new IncusError('Capsule create operation was not found.', 'NOT_FOUND', {
        operationId,
      })
    }
    return operation
  }

  public async optionalOperation(tx: CreateTransaction<TDatabase>, operationId: string) {
    const operations = this.persistence.tables.capsuleOperations
    const [identity] = await tx
      .select({
        ownerId: operations.ownerId,
        capsuleId: operations.capsuleId,
        type: operations.type,
      })
      .from(operations)
      .where(eq(operations.id, operationId))
      .limit(1)
    if (!identity || identity.type !== CapsuleOperationType.CREATE) {
      return null
    }
    await this.capsule(tx, identity.ownerId, identity.capsuleId)
    const [operation] = await tx
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.id, operationId),
          eq(operations.type, CapsuleOperationType.CREATE),
          eq(operations.ownerId, identity.ownerId),
          eq(operations.capsuleId, identity.capsuleId),
        ),
      )
      .for('update')
      .limit(1)
    if (!operation) {
      throw new IncusError('Capsule create identity changed while acquiring its parent locks.', 'CONFLICT', {
        operationId,
        ownerId: identity.ownerId,
        capsuleId: identity.capsuleId,
      })
    }
    return operation
  }

  public async extension(tx: CreateTransaction<TDatabase>, operationId: string) {
    const extension = await this.optionalExtension(tx, operationId)
    if (!extension) {
      throw new IncusError('Capsule create operation is missing its immutable create extension.', 'CONFLICT', {
        operationId,
      })
    }
    return extension
  }

  public async optionalExtension(tx: CreateTransaction<TDatabase>, operationId: string) {
    const extensions = this.persistence.tables.capsuleCreateOperations
    const [extension] = await tx
      .select()
      .from(extensions)
      .where(eq(extensions.operationId, operationId))
      .for('update')
      .limit(1)
    return extension ?? null
  }

  public async capsule(tx: CreateTransaction<TDatabase>, ownerId: string, capsuleId: string) {
    const capsules = this.persistence.tables.capsules
    const [capsule] = await tx
      .select()
      .from(capsules)
      .where(and(eq(capsules.id, capsuleId), eq(capsules.ownerId, ownerId)))
      .for('update')
      .limit(1)
    if (!capsule) {
      throw new IncusError('Capsule aggregate was not found.', 'NOT_FOUND', {
        ownerId,
        capsuleId,
      })
    }
    return capsule
  }

  /**
   * Includes the referenced branch even when its attribution is inconsistent.
   *
   * Filtering every candidate by the expected owner or capsule would hide the
   * contradictory row from lineage validation.
   */
  public async rootBranches(tx: CreateTransaction<TDatabase>, capsuleId: string, referencedBranchId: string | null) {
    const branches = this.persistence.tables.capsuleBranches
    const rootPredicate = and(eq(branches.capsuleId, capsuleId), eq(branches.isRootBranch, true))
    return await tx
      .select()
      .from(branches)
      .where(referencedBranchId === null ? rootPredicate : or(rootPredicate, eq(branches.id, referencedBranchId)))
      .orderBy(asc(branches.id))
      .for('update')
  }

  /**
   * Resource evidence is selected by operation or branch, not their
   * intersection, so inconsistent operation attribution cannot escape review.
   */
  public async resources(tx: CreateTransaction<TDatabase>, operationId: string, branchIds: readonly string[]) {
    const resources = this.persistence.tables.capsuleBranchResources
    const uniqueBranchIds = [...new Set(branchIds)]
    return await tx
      .select()
      .from(resources)
      .where(
        uniqueBranchIds.length === 0
          ? eq(resources.createdByOperationId, operationId)
          : or(eq(resources.createdByOperationId, operationId), inArray(resources.branchId, uniqueBranchIds)),
      )
      .orderBy(asc(resources.provider), asc(resources.resourceKey), asc(resources.id))
      .for('update')
  }
}
