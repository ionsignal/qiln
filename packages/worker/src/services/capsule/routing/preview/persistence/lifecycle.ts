import { eq, inArray } from 'drizzle-orm'
import type { CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { PreviewRecord } from '../types'
import type { PreviewLocks } from './locks'

/**
 * Owns durable preview withdrawal eligibility.
 *
 * Withdrawal and resume lock capsule → branch → preview rows so branch and
 * capsule lifecycle transitions cannot acquire the same rows in the opposite
 * order.
 */
export class PreviewLifecyclePersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly locks: PreviewLocks<TDatabase, TTables>,
  ) {}

  public async withdraw(ownerId: string, capsuleId: string, branchId: string): Promise<PreviewRecord[]> {
    return await this.persistence.db.transaction(async tx => {
      const scope = await this.locks.previews(tx, ownerId, capsuleId, branchId)
      if (scope.previews.length === 0) {
        return []
      }
      const ids = scope.previews.filter(preview => preview.withdrawalRequestedAt === null).map(preview => preview.id)
      if (ids.length === 0) {
        return scope.previews
      }
      const previews = this.persistence.tables.capsuleBranchPreviews
      const now = new Date()
      await tx
        .update(previews)
        .set({
          withdrawalRequestedAt: now,
          updatedAt: now,
        })
        .where(inArray(previews.id, ids))

      const refreshed = await tx
        .select()
        .from(previews)
        .where(eq(previews.branchId, branchId))
        .orderBy(previews.applicationName, previews.id)
        .for('update')
      return refreshed
    })
  }

  public async resume(ownerId: string, capsuleId: string, branchId: string): Promise<void> {
    await this.persistence.db.transaction(async tx => {
      const scope = await this.locks.previews(tx, ownerId, capsuleId, branchId)
      const ids = scope.previews.filter(preview => preview.withdrawalRequestedAt !== null).map(preview => preview.id)

      if (ids.length === 0) {
        return
      }
      const previews = this.persistence.tables.capsuleBranchPreviews
      await tx
        .update(previews)
        .set({
          withdrawalRequestedAt: null,
          updatedAt: new Date(),
        })
        .where(inArray(previews.id, ids))
    })
  }
}
