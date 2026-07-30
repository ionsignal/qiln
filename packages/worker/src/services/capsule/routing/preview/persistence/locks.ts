import { asc, eq } from 'drizzle-orm'
import type { CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError } from '../../../../../errors'
import type { PreviewRecord } from '../types'

export type PreviewTransaction<TDatabase extends PostgresJsDatabase> = Parameters<
  Parameters<TDatabase['transaction']>[0]
>[0]

export interface LockedPreviewCapsule {
  id: string
  ownerId: string
  lifecycleStatus: CapsuleTables['capsules']['$inferSelect']['lifecycleStatus']
  archivedAt: Date | null
}

export interface LockedPreviewBranch {
  id: string
  ownerId: string
  capsuleId: string
  name: string
  status: CapsuleTables['capsuleBranches']['$inferSelect']['status']
  runtimeIp: string | null
}

export interface LockedPreviewScope {
  capsule: LockedPreviewCapsule
  branch: LockedPreviewBranch
  preview: PreviewRecord
}

interface PreviewIdentity {
  id: string
  ownerId: string
  capsuleId: string
  branchId: string
}

/**
 * Owns the canonical row-lock order for preview persistence:
 *
 * Capsule → branch → preview row(s)
 *
 * Every preview writer must acquire its rows through this boundary. A
 * preliminary unlocked preview identity read is used only to discover the
 * parent rows. The identity is revalidated after all three rows are locked, so
 * it cannot authorize a transition if the durable relationship changed.
 */
export class PreviewLocks<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly persistence: CapsulePersistence<TDatabase, TTables>) {}

  public async branch(
    tx: PreviewTransaction<TDatabase>,
    ownerId: string,
    capsuleId: string,
    branchId: string,
  ): Promise<{
    capsule: LockedPreviewCapsule
    branch: LockedPreviewBranch
  }> {
    const { capsules, capsuleBranches } = this.persistence.tables
    const [capsule] = await tx
      .select({
        id: capsules.id,
        ownerId: capsules.ownerId,
        lifecycleStatus: capsules.lifecycleStatus,
        archivedAt: capsules.archivedAt,
      })
      .from(capsules)
      .where(eq(capsules.id, capsuleId))
      .for('update')
      .limit(1)
    if (!capsule || capsule.ownerId !== ownerId) {
      throw new IncusError('Preview capsule was not found or access was denied.', 'NOT_FOUND', {
        ownerId,
        capsuleId,
        branchId,
      })
    }
    const [branch] = await tx
      .select({
        id: capsuleBranches.id,
        ownerId: capsuleBranches.ownerId,
        capsuleId: capsuleBranches.capsuleId,
        name: capsuleBranches.name,
        status: capsuleBranches.status,
        runtimeIp: capsuleBranches.runtimeIp,
      })
      .from(capsuleBranches)
      .where(eq(capsuleBranches.id, branchId))
      .for('update')
      .limit(1)
    if (!branch) {
      throw new IncusError('Preview branch was not found.', 'NOT_FOUND', {
        ownerId,
        capsuleId,
        branchId,
      })
    }
    if (branch.ownerId !== ownerId || branch.capsuleId !== capsuleId) {
      throw new IncusError('Preview branch does not belong to its expected capsule owner.', 'CONFLICT', {
        ownerId,
        capsuleId,
        branchId,
        branchOwnerId: branch.ownerId,
        branchCapsuleId: branch.capsuleId,
      })
    }
    return {
      capsule,
      branch,
    }
  }

  public async preview(tx: PreviewTransaction<TDatabase>, previewId: string): Promise<LockedPreviewScope> {
    const identity = await this.identity(tx, previewId)
    const scope = await this.branch(tx, identity.ownerId, identity.capsuleId, identity.branchId)
    const previews = this.persistence.tables.capsuleBranchPreviews
    const [preview] = await tx.select().from(previews).where(eq(previews.id, previewId)).for('update').limit(1)
    if (!preview) {
      throw new IncusError('Branch preview was not found after locking its capsule and branch.', 'NOT_FOUND', {
        previewId,
      })
    }
    if (
      preview.ownerId !== identity.ownerId ||
      preview.capsuleId !== identity.capsuleId ||
      preview.branchId !== identity.branchId ||
      preview.ownerId !== scope.capsule.ownerId ||
      preview.ownerId !== scope.branch.ownerId ||
      preview.capsuleId !== scope.capsule.id ||
      preview.branchId !== scope.branch.id
    ) {
      throw new IncusError('Branch preview no longer matches its locked capsule and branch ownership.', 'CONFLICT', {
        previewId,
        initialOwnerId: identity.ownerId,
        initialCapsuleId: identity.capsuleId,
        initialBranchId: identity.branchId,
        previewOwnerId: preview.ownerId,
        previewCapsuleId: preview.capsuleId,
        previewBranchId: preview.branchId,
      })
    }
    return {
      ...scope,
      preview,
    }
  }

  public async previews(
    tx: PreviewTransaction<TDatabase>,
    ownerId: string,
    capsuleId: string,
    branchId: string,
  ): Promise<{
    capsule: LockedPreviewCapsule
    branch: LockedPreviewBranch
    previews: PreviewRecord[]
  }> {
    const scope = await this.branch(tx, ownerId, capsuleId, branchId)
    const previews = this.persistence.tables.capsuleBranchPreviews
    const records = await tx
      .select()
      .from(previews)
      .where(eq(previews.branchId, branchId))
      .orderBy(asc(previews.applicationName), asc(previews.id))
      .for('update')
    for (const preview of records) {
      if (
        preview.ownerId === ownerId &&
        preview.capsuleId === capsuleId &&
        preview.branchId === branchId &&
        preview.ownerId === scope.capsule.ownerId &&
        preview.ownerId === scope.branch.ownerId
      ) {
        continue
      }
      throw new IncusError('Branch preview does not match its locked capsule and branch ownership.', 'CONFLICT', {
        previewId: preview.id,
        ownerId,
        capsuleId,
        branchId,
        previewOwnerId: preview.ownerId,
        previewCapsuleId: preview.capsuleId,
        previewBranchId: preview.branchId,
      })
    }
    return {
      ...scope,
      previews: records,
    }
  }

  private async identity(tx: PreviewTransaction<TDatabase>, previewId: string): Promise<PreviewIdentity> {
    const previews = this.persistence.tables.capsuleBranchPreviews
    const [identity] = await tx
      .select({
        id: previews.id,
        ownerId: previews.ownerId,
        capsuleId: previews.capsuleId,
        branchId: previews.branchId,
      })
      .from(previews)
      .where(eq(previews.id, previewId))
      .limit(1)
    if (!identity) {
      throw new IncusError('Branch preview was not found.', 'NOT_FOUND', {
        previewId,
      })
    }
    return identity
  }
}
