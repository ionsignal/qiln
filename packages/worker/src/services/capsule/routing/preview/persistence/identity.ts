import { and, eq } from 'drizzle-orm'
import {
  verifyCapsuleRouteApplicationPin,
  type CapsulePersistence,
  type CapsuleRouteApplicationPin,
  type CapsuleTables,
} from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError, isUniqueConstraintViolation } from '../../../../../errors'
import type { PreviewBranch, PreviewIdentity, PreviewRecord } from '../types'
import type { PreviewLocks } from './locks'

/**
 * Owns durable preview allocation and immutable identity validation.
 *
 * Preview identity is created under the canonical capsule → branch lock order.
 * Application, hostname, and provider route identity cannot be rewritten after
 * allocation.
 */
export class PreviewIdentityPersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly locks: PreviewLocks<TDatabase, TTables>,
  ) {}

  public async ensure(
    branch: PreviewBranch,
    application: CapsuleRouteApplicationPin,
    identity: PreviewIdentity,
  ): Promise<PreviewRecord> {
    try {
      return await this.persistence.db.transaction(async tx => {
        const scope = await this.locks.branch(tx, branch.ownerId, branch.capsuleId, branch.id)
        if (
          scope.branch.name !== branch.name ||
          scope.capsule.lifecycleStatus !== branch.lifecycleStatus ||
          this.timestamp(scope.capsule.archivedAt) !== this.timestamp(branch.archivedAt)
        ) {
          throw new IncusError('Preview branch candidate changed before durable preview allocation.', 'CONFLICT', {
            branchId: branch.id,
            expectedBranchName: branch.name,
            actualBranchName: scope.branch.name,
            expectedLifecycleStatus: branch.lifecycleStatus,
            actualLifecycleStatus: scope.capsule.lifecycleStatus,
            expectedArchivedAt: branch.archivedAt?.toISOString() ?? null,
            actualArchivedAt: scope.capsule.archivedAt?.toISOString() ?? null,
          })
        }
        const previews = this.persistence.tables.capsuleBranchPreviews
        const [existing] = await tx
          .select()
          .from(previews)
          .where(and(eq(previews.branchId, branch.id), eq(previews.applicationName, application.application.name)))
          .for('update')
          .limit(1)
        if (existing) {
          this.assertIdentity(existing, branch, application, identity)
          return existing
        }
        const now = new Date()
        const [created] = await tx
          .insert(previews)
          .values({
            ownerId: branch.ownerId,
            capsuleId: branch.capsuleId,
            branchId: branch.id,
            applicationName: application.application.name,
            applicationPin: application,
            host: identity.host,
            providerRouteId: identity.providerRouteId,
            status: 'inactive',
            createdAt: now,
            updatedAt: now,
          })
          .returning()

        if (!created) {
          throw new IncusError('Failed to create durable branch preview state.', 'API_ERROR', {
            branchId: branch.id,
            applicationName: application.application.name,
          })
        }
        return created
      })
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error
      }
      const existing = await this.find(branch.id, application.application.name)
      if (!existing) {
        throw new IncusError(
          'Branch preview identity conflicted with existing routing state and could not be reloaded.',
          'CONFLICT',
          {
            branchId: branch.id,
            applicationName: application.application.name,
            host: identity.host,
            providerRouteId: identity.providerRouteId,
          },
        )
      }
      this.assertIdentity(existing, branch, application, identity)
      return existing
    }
  }

  private async find(branchId: string, applicationName: string): Promise<PreviewRecord | null> {
    const previews = this.persistence.tables.capsuleBranchPreviews
    const [record] = await this.persistence.db
      .select()
      .from(previews)
      .where(and(eq(previews.branchId, branchId), eq(previews.applicationName, applicationName)))
      .limit(1)
    return record ?? null
  }

  private assertIdentity(
    preview: PreviewRecord,
    branch: PreviewBranch,
    application: CapsuleRouteApplicationPin,
    identity: PreviewIdentity,
  ): void {
    const persisted = verifyCapsuleRouteApplicationPin(preview.applicationPin)
    const expected = verifyCapsuleRouteApplicationPin(application)
    if (
      preview.ownerId !== branch.ownerId ||
      preview.capsuleId !== branch.capsuleId ||
      preview.branchId !== branch.id ||
      preview.applicationName !== expected.application.name ||
      persisted.digest !== expected.digest ||
      preview.host !== identity.host ||
      preview.providerRouteId !== identity.providerRouteId
    ) {
      throw new IncusError(
        'Existing branch preview identity conflicts with historical branch provenance.',
        'CONFLICT',
        {
          previewId: preview.id,
          branchId: branch.id,
          applicationName: expected.application.name,
        },
      )
    }
  }

  private timestamp(value: Date | null): number | null {
    return value?.getTime() ?? null
  }
}
