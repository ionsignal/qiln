import { asc, inArray } from 'drizzle-orm'
import type { CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError } from '../../../../errors'

type Transaction<TDatabase extends PostgresJsDatabase> = Parameters<Parameters<TDatabase['transaction']>[0]>[0]

/**
 * Enforces the lifecycle boundary between mutable branch previews and capsule
 * mutations that can retire, freeze, or replace the preview upstream.
 *
 * A preview must be durably inactive before its branch can stop or enter
 * Snapshot Capture, and before its capsule can archive or destroy. Locking
 * preview rows inside the caller's aggregate transaction prevents a concurrent
 * Caddy apply from racing past that lifecycle boundary.
 */
export class PreviewGate<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly persistence: CapsulePersistence<TDatabase, TTables>) {}

  public async assertBranchWithdrawn(
    tx: Transaction<TDatabase>,
    ownerId: string,
    capsuleId: string,
    branchId: string,
  ): Promise<void> {
    await this.assertBranchesWithdrawn(tx, ownerId, capsuleId, [branchId])
  }

  public async assertBranchesWithdrawn(
    tx: Transaction<TDatabase>,
    ownerId: string,
    capsuleId: string,
    branchIds: readonly string[],
  ): Promise<void> {
    if (branchIds.length === 0) {
      return
    }
    const previews = this.persistence.tables.capsuleBranchPreviews
    const records = await tx
      .select({
        id: previews.id,
        ownerId: previews.ownerId,
        capsuleId: previews.capsuleId,
        branchId: previews.branchId,
        applicationName: previews.applicationName,
        status: previews.status,
      })
      .from(previews)
      .where(inArray(previews.branchId, [...new Set(branchIds)]))
      .orderBy(asc(previews.branchId), asc(previews.applicationName), asc(previews.id))
      .for('update')
    const ownershipMismatches = records.filter(
      preview => preview.ownerId !== ownerId || preview.capsuleId !== capsuleId,
    )
    if (ownershipMismatches.length > 0) {
      throw new IncusError('Branch preview ownership does not match the lifecycle mutation aggregate.', 'CONFLICT', {
        ownerId,
        capsuleId,
        previews: ownershipMismatches.map(preview => ({
          previewId: preview.id,
          previewOwnerId: preview.ownerId,
          previewCapsuleId: preview.capsuleId,
          branchId: preview.branchId,
          applicationName: preview.applicationName,
          status: preview.status,
        })),
      })
    }
    const blockingPreviews = records.filter(preview => preview.status !== 'inactive')
    if (blockingPreviews.length === 0) {
      return
    }
    throw new IncusError(
      'Capsule lifecycle mutation requires every branch preview route to be fully withdrawn first.',
      'CONFLICT',
      {
        ownerId,
        capsuleId,
        previews: blockingPreviews.map(preview => ({
          previewId: preview.id,
          branchId: preview.branchId,
          applicationName: preview.applicationName,
          status: preview.status,
        })),
      },
    )
  }
}
