import { and, eq, inArray } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  verifyCapsuleRouteApplicationPin,
  type CapsulePersistence,
  type CapsuleRouteApplicationPin,
  type CapsuleTables,
} from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError, isUniqueConstraintViolation } from '../../../../../errors'
import type { PreviewAdmission, PreviewBranch, PreviewIdentity, PreviewRecord } from '../types'
import type { PreviewLocks } from './locks'

const NONTERMINAL_OPERATION_STATUSES = [CapsuleOperationStatus.ACCEPTED, CapsuleOperationStatus.RUNNING] as const

/**
 * Owns durable preview allocation and immutable identity validation.
 *
 * Preview identity is created under the canonical capsule → branch lock order.
 * Application, hostname, and provider route identity cannot be rewritten after
 * allocation. Expected eligibility changes skip allocation without classifying
 * an existing preview as uncertain.
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
  ): Promise<PreviewAdmission> {
    const applicationPin = verifyCapsuleRouteApplicationPin(application)
    try {
      return await this.persistence.db.transaction(async (tx): Promise<PreviewAdmission> => {
        const scope = await this.locks.branch(tx, branch.ownerId, branch.capsuleId, branch.id)
        if (scope.branch.name !== branch.name) {
          throw new IncusError('Preview branch candidate no longer matches its durable branch identity.', 'CONFLICT', {
            branchId: branch.id,
            expectedBranchName: branch.name,
            actualBranchName: scope.branch.name,
          })
        }
        const previews = this.persistence.tables.capsuleBranchPreviews
        const [existing] = await tx
          .select()
          .from(previews)
          .where(and(eq(previews.branchId, branch.id), eq(previews.applicationName, applicationPin.application.name)))
          .for('update')
          .limit(1)
        if (existing) {
          this.assertIdentity(existing, branch, applicationPin, identity)
        }
        // The capsule lock serializes operation acceptance with this admission
        // check, so a candidate cannot allocate after an operation takes ownership.
        const operations = this.persistence.tables.capsuleOperations
        const [operation] = await tx
          .select({
            id: operations.id,
          })
          .from(operations)
          .where(
            and(eq(operations.capsuleId, branch.capsuleId), inArray(operations.status, NONTERMINAL_OPERATION_STATUSES)),
          )
          .limit(1)
        if (operation) {
          return {
            kind: 'skipped',
            reason: 'operation_blocked',
          }
        }
        if (
          scope.capsule.lifecycleStatus !== 'active' ||
          scope.capsule.archivedAt !== null ||
          scope.capsule.lifecycleStatus !== branch.lifecycleStatus ||
          this.timestamp(scope.capsule.archivedAt) !== this.timestamp(branch.archivedAt)
        ) {
          return {
            kind: 'skipped',
            reason: 'lifecycle_changed',
          }
        }
        if (
          scope.branch.status !== 'online' ||
          scope.branch.runtimeIp === null ||
          scope.branch.status !== branch.status ||
          scope.branch.runtimeIp !== branch.runtimeIp
        ) {
          return {
            kind: 'skipped',
            reason: 'runtime_changed',
          }
        }
        if (existing && existing.withdrawalRequestedAt !== null) {
          return {
            kind: 'skipped',
            reason: 'withdrawal_requested',
          }
        }
        if (existing) {
          return {
            kind: 'proceed',
            preview: existing,
          }
        }
        const now = new Date()
        const [created] = await tx
          .insert(previews)
          .values({
            ownerId: branch.ownerId,
            capsuleId: branch.capsuleId,
            branchId: branch.id,
            applicationName: applicationPin.application.name,
            applicationPin,
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
            applicationName: applicationPin.application.name,
          })
        }
        return {
          kind: 'proceed',
          preview: created,
        }
      })
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error
      }
      // Same-branch allocation is already serialized by the parent locks.
      // A remaining uniqueness conflict must not bypass admission via an unlocked read.
      throw new IncusError('Branch preview identity conflicts with existing routing state.', 'CONFLICT', {
        branchId: branch.id,
        applicationName: applicationPin.application.name,
        host: identity.host,
        providerRouteId: identity.providerRouteId,
      })
    }
  }

  private assertIdentity(
    preview: PreviewRecord,
    branch: PreviewBranch,
    application: CapsuleRouteApplicationPin,
    identity: PreviewIdentity,
  ): void {
    const persisted = verifyCapsuleRouteApplicationPin(preview.applicationPin)
    if (
      preview.ownerId !== branch.ownerId ||
      preview.capsuleId !== branch.capsuleId ||
      preview.branchId !== branch.id ||
      preview.applicationName !== application.application.name ||
      persisted.digest !== application.digest ||
      preview.host !== identity.host ||
      preview.providerRouteId !== identity.providerRouteId
    ) {
      throw new IncusError(
        'Existing branch preview identity conflicts with historical branch provenance.',
        'CONFLICT',
        {
          previewId: preview.id,
          branchId: branch.id,
          applicationName: application.application.name,
        },
      )
    }
  }

  private timestamp(value: Date | null): number | null {
    return value?.getTime() ?? null
  }
}
