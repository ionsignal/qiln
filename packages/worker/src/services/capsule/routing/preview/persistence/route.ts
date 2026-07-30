import { and, eq, inArray } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleRouteConfigurationKeySchema,
  digestCapsuleRouteConfiguration,
  verifyCapsuleRouteApplicationPin,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError } from '../../../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from '../../../failures'
import { toJsonObject } from '../../../persistence/json'
import type { PreviewPlan, PreviewRecord } from '../types'
import type { PreviewLocks, PreviewTransaction } from './locks'

const NONTERMINAL_OPERATION_STATUSES = [CapsuleOperationStatus.ACCEPTED, CapsuleOperationStatus.RUNNING] as const

const APPLYABLE_STATUSES = ['inactive', 'active', 'degraded', 'verifying'] as const
const REMOVABLE_STATUSES = ['active', 'degraded', 'verifying'] as const
const INACTIVE_STATUSES = ['inactive', 'applying', 'verifying', 'active', 'degraded', 'removing'] as const

interface CurrentConfiguration {
  runtimeIp: string
  configurationKey: string
  configurationDigest: string
  configuration: Record<string, unknown>
  appliedAt: Date
}

interface PendingConfiguration {
  runtimeIp: string
  configurationKey: string
  configurationDigest: string
  configuration: Record<string, unknown>
  applyIntentAt: Date
}

/**
 * Owns durable Caddy mutation transitions for branch previews.
 *
 * Apply eligibility, capsule/branch ownership, the capsule-wide operation
 * fence, plan consistency, and the `applying` write remain in one transaction.
 */
export class PreviewRoutePersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly locks: PreviewLocks<TDatabase, TTables>,
  ) {}

  public async apply(id: string, plan: PreviewPlan): Promise<PreviewRecord> {
    return await this.persistence.db.transaction(async tx => {
      const scope = await this.locks.branch(tx, plan.ownerId, plan.capsuleId, plan.branchId)
      if (scope.capsule.lifecycleStatus !== 'active' || scope.capsule.archivedAt !== null) {
        throw new IncusError('Branch preview capsule is no longer active and unarchived.', 'CONFLICT', {
          capsuleId: plan.capsuleId,
          ownerId: plan.ownerId,
          lifecycleStatus: scope.capsule.lifecycleStatus,
          archived: scope.capsule.archivedAt !== null,
        })
      }
      if (
        scope.branch.status !== 'online' ||
        scope.branch.runtimeIp === null ||
        scope.branch.runtimeIp !== plan.runtimeIp
      ) {
        throw new IncusError('Branch preview source branch is no longer eligible for Caddy application.', 'CONFLICT', {
          previewId: plan.previewId,
          branchId: plan.branchId,
          branchStatus: scope.branch.status,
          branchRuntimeIp: scope.branch.runtimeIp,
          plannedRuntimeIp: plan.runtimeIp,
        })
      }

      await this.assertOperationFence(tx, plan)

      const locked = await this.locks.preview(tx, id)
      const preview = locked.preview

      this.assertPlan(preview, plan)
      this.assertApplyState(preview)

      const previews = this.persistence.tables.capsuleBranchPreviews
      const now = new Date()
      const [record] = await tx
        .update(previews)
        .set({
          status: 'applying',
          pendingRuntimeIp: plan.runtimeIp,
          pendingConfigurationKey: plan.configurationKey,
          pendingConfigurationDigest: plan.configurationDigest,
          pendingConfiguration: plan.configuration,
          applyIntentAt: now,
          removeIntentAt: null,
          failureCode: null,
          failureMessage: null,
          failureDetails: null,
          failureAt: null,
          updatedAt: now,
        })
        .where(and(eq(previews.id, id), eq(previews.status, preview.status), eq(previews.updatedAt, preview.updatedAt)))
        .returning()

      return this.require(record, id, 'applying')
    })
  }

  public async applied(id: string): Promise<PreviewRecord> {
    return await this.persistence.db.transaction(async tx => {
      const preview = (await this.locks.preview(tx, id)).preview
      if (preview.status !== 'applying') {
        throw new IncusError('Branch preview is not waiting for Caddy application confirmation.', 'CONFLICT', {
          previewId: id,
          status: preview.status,
        })
      }
      const pending = this.pending(preview)
      const previews = this.persistence.tables.capsuleBranchPreviews
      const now = new Date()
      const [record] = await tx
        .update(previews)
        .set({
          status: 'verifying',
          currentRuntimeIp: pending.runtimeIp,
          currentConfigurationKey: pending.configurationKey,
          currentConfigurationDigest: pending.configurationDigest,
          currentConfiguration: pending.configuration,
          pendingRuntimeIp: null,
          pendingConfigurationKey: null,
          pendingConfigurationDigest: null,
          pendingConfiguration: null,
          applyIntentAt: null,
          appliedAt: now,
          verificationIntentAt: now,
          verificationEvidence: null,
          verifiedAt: null,
          removeIntentAt: null,
          failureCode: null,
          failureMessage: null,
          failureDetails: null,
          failureAt: null,
          updatedAt: now,
        })
        .where(and(eq(previews.id, id), eq(previews.status, 'applying'), eq(previews.updatedAt, preview.updatedAt)))
        .returning()
      return this.require(record, id, 'verifying')
    })
  }

  public async rejectApply(id: string, error: unknown, context: Record<string, unknown>): Promise<PreviewRecord> {
    return await this.persistence.db.transaction(async tx => {
      const preview = (await this.locks.preview(tx, id)).preview
      if (preview.status !== 'applying') {
        throw new IncusError('Branch preview is not waiting for Caddy application.', 'CONFLICT', {
          previewId: id,
          status: preview.status,
        })
      }
      this.pending(preview)
      if (preview.currentRuntimeIp === null) {
        return await this.inactiveInTransaction(tx, preview)
      }
      this.current(preview)
      const previews = this.persistence.tables.capsuleBranchPreviews
      const now = new Date()
      const details = createFailureDetails(error, context) ?? {
        context,
      }
      const [record] = await tx
        .update(previews)
        .set({
          status: 'degraded',
          pendingRuntimeIp: null,
          pendingConfigurationKey: null,
          pendingConfigurationDigest: null,
          pendingConfiguration: null,
          applyIntentAt: null,
          verificationIntentAt: now,
          verificationEvidence: null,
          verifiedAt: null,
          failureCode: failureCodeFromUnknown(error),
          failureMessage: failureMessageFromUnknown(error, 'Branch preview Caddy application was rejected.'),
          failureDetails: toJsonObject(details, 'branch preview Caddy application rejection details'),
          failureAt: now,
          updatedAt: now,
        })
        .where(and(eq(previews.id, id), eq(previews.status, 'applying'), eq(previews.updatedAt, preview.updatedAt)))
        .returning()
      return this.require(record, id, 'degraded')
    })
  }

  public async removing(id: string): Promise<PreviewRecord> {
    return await this.persistence.db.transaction(async tx => {
      const preview = (await this.locks.preview(tx, id)).preview
      if (!REMOVABLE_STATUSES.includes(preview.status as (typeof REMOVABLE_STATUSES)[number])) {
        throw new IncusError('Branch preview cannot begin removal from its current status.', 'CONFLICT', {
          previewId: id,
          status: preview.status,
        })
      }
      this.current(preview)
      const previews = this.persistence.tables.capsuleBranchPreviews
      const now = new Date()
      const [record] = await tx
        .update(previews)
        .set({
          status: 'removing',
          removeIntentAt: now,
          failureCode: null,
          failureMessage: null,
          failureDetails: null,
          failureAt: null,
          updatedAt: now,
        })
        .where(and(eq(previews.id, id), eq(previews.status, preview.status), eq(previews.updatedAt, preview.updatedAt)))
        .returning()
      return this.require(record, id, 'removing')
    })
  }

  public async rejectRemoval(id: string, error: unknown, context: Record<string, unknown>): Promise<PreviewRecord> {
    return await this.persistence.db.transaction(async tx => {
      const preview = (await this.locks.preview(tx, id)).preview
      if (preview.status !== 'removing') {
        throw new IncusError('Branch preview is not waiting for Caddy removal.', 'CONFLICT', {
          previewId: id,
          status: preview.status,
        })
      }
      this.current(preview)
      const previews = this.persistence.tables.capsuleBranchPreviews
      const now = new Date()
      const details = createFailureDetails(error, context) ?? {
        context,
      }
      const [record] = await tx
        .update(previews)
        .set({
          status: 'degraded',
          verificationIntentAt: now,
          verificationEvidence: null,
          verifiedAt: null,
          removeIntentAt: null,
          failureCode: failureCodeFromUnknown(error),
          failureMessage: failureMessageFromUnknown(error, 'Branch preview Caddy removal was rejected.'),
          failureDetails: toJsonObject(details, 'branch preview Caddy removal rejection details'),
          failureAt: now,
          updatedAt: now,
        })
        .where(and(eq(previews.id, id), eq(previews.status, 'removing'), eq(previews.updatedAt, preview.updatedAt)))
        .returning()
      return this.require(record, id, 'degraded')
    })
  }

  public async inactive(id: string): Promise<PreviewRecord> {
    return await this.persistence.db.transaction(async tx => {
      const preview = (await this.locks.preview(tx, id)).preview
      if (!INACTIVE_STATUSES.includes(preview.status as (typeof INACTIVE_STATUSES)[number])) {
        throw new IncusError('Branch preview cannot become inactive from its current status.', 'CONFLICT', {
          previewId: id,
          status: preview.status,
        })
      }
      return await this.inactiveInTransaction(tx, preview)
    })
  }

  private async assertOperationFence(tx: PreviewTransaction<TDatabase>, plan: PreviewPlan): Promise<void> {
    const operations = this.persistence.tables.capsuleOperations
    const [operation] = await tx
      .select({
        id: operations.id,
        type: operations.type,
        status: operations.status,
      })
      .from(operations)
      .where(and(eq(operations.capsuleId, plan.capsuleId), inArray(operations.status, NONTERMINAL_OPERATION_STATUSES)))
      .limit(1)

    if (!operation) {
      return
    }
    throw new IncusError(
      'Branch preview cannot mutate ingress while the capsule has a nonterminal operation.',
      'CONFLICT',
      {
        previewId: plan.previewId,
        capsuleId: plan.capsuleId,
        operationId: operation.id,
        operationType: operation.type,
        operationStatus: operation.status,
      },
    )
  }

  private assertApplyState(preview: PreviewRecord): void {
    if (!APPLYABLE_STATUSES.includes(preview.status as (typeof APPLYABLE_STATUSES)[number])) {
      throw new IncusError('Branch preview cannot begin Caddy application from its current status.', 'CONFLICT', {
        previewId: preview.id,
        status: preview.status,
      })
    }
    if (preview.withdrawalRequestedAt !== null) {
      throw new IncusError(
        'Branch preview is waiting for ingress withdrawal and cannot recreate its Caddy route.',
        'CONFLICT',
        {
          previewId: preview.id,
          withdrawalRequestedAt: preview.withdrawalRequestedAt.toISOString(),
        },
      )
    }
    if (
      preview.pendingRuntimeIp !== null ||
      preview.pendingConfigurationKey !== null ||
      preview.pendingConfigurationDigest !== null ||
      preview.pendingConfiguration !== null ||
      preview.applyIntentAt !== null
    ) {
      throw new IncusError('Branch preview already has unresolved pending Caddy configuration.', 'CONFLICT', {
        previewId: preview.id,
        status: preview.status,
      })
    }
  }

  private assertPlan(preview: PreviewRecord, plan: PreviewPlan): void {
    const persistedApplication = verifyCapsuleRouteApplicationPin(preview.applicationPin)
    const plannedApplication = verifyCapsuleRouteApplicationPin(plan.application)
    const configurationKey = CapsuleRouteConfigurationKeySchema.safeParse(plan.configurationKey)
    const configurationDigest = digestCapsuleRouteConfiguration(plan.configuration)
    if (
      preview.id !== plan.previewId ||
      preview.ownerId !== plan.ownerId ||
      preview.capsuleId !== plan.capsuleId ||
      preview.branchId !== plan.branchId ||
      preview.applicationName !== plannedApplication.application.name ||
      plan.applicationName !== plannedApplication.application.name ||
      persistedApplication.digest !== plannedApplication.digest ||
      preview.host !== plan.host ||
      preview.providerRouteId !== plan.providerRouteId ||
      !configurationKey.success ||
      configurationKey.data !== plan.providerRouteId ||
      configurationDigest !== plan.configurationDigest
    ) {
      throw new IncusError('Preview Caddy plan does not match durable preview identity.', 'CONFLICT', {
        previewId: preview.id,
        branchId: preview.branchId,
        applicationName: preview.applicationName,
      })
    }
  }

  private current(preview: PreviewRecord): CurrentConfiguration {
    if (
      preview.currentRuntimeIp === null ||
      preview.currentConfigurationKey === null ||
      preview.currentConfigurationDigest === null ||
      preview.currentConfiguration === null ||
      preview.appliedAt === null
    ) {
      throw new IncusError('Branch preview has no confirmed current Caddy configuration.', 'CONFLICT', {
        previewId: preview.id,
        status: preview.status,
      })
    }
    return {
      runtimeIp: preview.currentRuntimeIp,
      configurationKey: preview.currentConfigurationKey,
      configurationDigest: preview.currentConfigurationDigest,
      configuration: preview.currentConfiguration,
      appliedAt: preview.appliedAt,
    }
  }

  private pending(preview: PreviewRecord): PendingConfiguration {
    if (
      preview.pendingRuntimeIp === null ||
      preview.pendingConfigurationKey === null ||
      preview.pendingConfigurationDigest === null ||
      preview.pendingConfiguration === null ||
      preview.applyIntentAt === null
    ) {
      throw new IncusError('Branch preview has no pending Caddy configuration.', 'CONFLICT', {
        previewId: preview.id,
        status: preview.status,
      })
    }
    return {
      runtimeIp: preview.pendingRuntimeIp,
      configurationKey: preview.pendingConfigurationKey,
      configurationDigest: preview.pendingConfigurationDigest,
      configuration: preview.pendingConfiguration,
      applyIntentAt: preview.applyIntentAt,
    }
  }

  private async inactiveInTransaction(
    tx: PreviewTransaction<TDatabase>,
    preview: PreviewRecord,
  ): Promise<PreviewRecord> {
    const previews = this.persistence.tables.capsuleBranchPreviews
    const now = new Date()
    const [record] = await tx
      .update(previews)
      .set({
        status: 'inactive',
        currentRuntimeIp: null,
        currentConfigurationKey: null,
        currentConfigurationDigest: null,
        currentConfiguration: null,
        pendingRuntimeIp: null,
        pendingConfigurationKey: null,
        pendingConfigurationDigest: null,
        pendingConfiguration: null,
        applyIntentAt: null,
        appliedAt: null,
        verificationIntentAt: null,
        verificationEvidence: null,
        verifiedAt: null,
        removeIntentAt: null,
        failureCode: null,
        failureMessage: null,
        failureDetails: null,
        failureAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(previews.id, preview.id),
          eq(previews.status, preview.status),
          eq(previews.updatedAt, preview.updatedAt),
        ),
      )
      .returning()
    return this.require(record, preview.id, 'inactive')
  }

  private require(record: PreviewRecord | undefined, previewId: string, status: string): PreviewRecord {
    if (!record) {
      throw new IncusError(`Failed to transition branch preview to '${status}'.`, 'CONFLICT', {
        previewId,
        status,
      })
    }
    return record
  }
}
