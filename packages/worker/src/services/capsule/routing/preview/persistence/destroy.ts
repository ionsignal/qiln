import { and, asc, eq, inArray, or } from 'drizzle-orm'
import type { CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError } from '../../../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from '../../../failures'
import { toJsonObject } from '../../../persistence/json'
import type { PreviewRecord } from '../types'
import type { PreviewTransaction } from './locks'

export type PreviewDestroySource = 'current' | 'pending'

/**
 * Explicit force-destroy recovery authority.
 *
 * Every transition revalidates persisted force policy and provider intent under
 * capsule → operation → branch → preview locks. Ordinary reconciliation cannot
 * use these transitions without a running forced destroy.
 */
export class PreviewDestroyPersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly persistence: CapsulePersistence<TDatabase, TTables>) {}

  public async load(operationId: string): Promise<PreviewRecord[]> {
    return await this.persistence.db.transaction(async tx => {
      return await this.lock(tx, operationId)
    })
  }

  public async removing(
    operationId: string,
    observed: PreviewRecord,
    source: PreviewDestroySource,
  ): Promise<PreviewRecord> {
    return await this.persistence.db.transaction(async tx => {
      const preview = this.current(await this.lock(tx, operationId), observed)
      const runtimeIp = source === 'pending' ? preview.pendingRuntimeIp : preview.currentRuntimeIp
      const configurationKey =
        source === 'pending' ? preview.pendingConfigurationKey : preview.currentConfigurationKey
      const configurationDigest =
        source === 'pending' ? preview.pendingConfigurationDigest : preview.currentConfigurationDigest
      const configuration =
        source === 'pending' ? preview.pendingConfiguration : preview.currentConfiguration
      const confirmedAt = source === 'pending' ? preview.applyIntentAt : preview.appliedAt
      if (
        runtimeIp === null ||
        configurationKey === null ||
        configurationDigest === null ||
        configuration === null ||
        confirmedAt === null
      ) {
        throw new IncusError('Preview withdrawal has no complete observed configuration authority.', 'CONFLICT', {
          operationId,
          previewId: preview.id,
          source,
        })
      }
      const previews = this.persistence.tables.capsuleBranchPreviews
      const now = new Date()
      const [record] = await tx
        .update(previews)
        .set({
          status: 'removing',
          withdrawalRequestedAt: preview.withdrawalRequestedAt ?? now,
          currentRuntimeIp: runtimeIp,
          currentConfigurationKey: configurationKey,
          currentConfigurationDigest: configurationDigest,
          currentConfiguration: configuration,
          pendingRuntimeIp: null,
          pendingConfigurationKey: null,
          pendingConfigurationDigest: null,
          pendingConfiguration: null,
          applyIntentAt: null,
          appliedAt: source === 'pending' ? now : confirmedAt,
          verificationIntentAt: null,
          verificationEvidence: null,
          verifiedAt: null,
          removeIntentAt: now,
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
      return this.require(record, operationId, preview.id)
    })
  }

  /**
   * Called only after Caddy positively reports the route absent.
   *
   * Force may clear cleanup-required accounting, but it preserves the preview's
   * immutable identity and leaves withdrawal requested.
   */
  public async inactive(operationId: string, observed: PreviewRecord): Promise<PreviewRecord> {
    return await this.persistence.db.transaction(async tx => {
      const preview = this.current(await this.lock(tx, operationId), observed)
      const previews = this.persistence.tables.capsuleBranchPreviews
      const now = new Date()
      const [record] = await tx
        .update(previews)
        .set({
          status: 'inactive',
          withdrawalRequestedAt: preview.withdrawalRequestedAt ?? now,
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
      return this.require(record, operationId, preview.id)
    })
  }

  /**
   * Preserve configuration evidence after uncertainty rather than allowing
   * ordinary reconciliation to retry an interrupted force withdrawal.
   */
  public async cleanup(
    operationId: string,
    observed: PreviewRecord,
    error: unknown,
  ): Promise<PreviewRecord | null> {
    return await this.persistence.db.transaction(async tx => {
      const records = await this.lock(tx, operationId)
      const preview = records.find(record => record.id === observed.id)
      if (!preview || !this.matches(preview, observed) || preview.status === 'cleanup_required') {
        return null
      }
      const previews = this.persistence.tables.capsuleBranchPreviews
      const now = new Date()
      const details = createFailureDetails(error, {
        operationId,
        previewId: preview.id,
        phase: 'force_destroy_preview_withdrawal',
      }) ?? { operationId, previewId: preview.id }
      const [record] = await tx
        .update(previews)
        .set({
          status: 'cleanup_required',
          withdrawalRequestedAt: preview.withdrawalRequestedAt ?? now,
          failureCode: failureCodeFromUnknown(error),
          failureMessage: failureMessageFromUnknown(error, 'Force-destroy preview withdrawal requires inspection.'),
          failureDetails: toJsonObject(details, 'force-destroy preview failure'),
          failureAt: now,
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
      return this.require(record, operationId, preview.id)
    })
  }

  public async assertWithdrawn(operationId: string): Promise<void> {
    await this.persistence.db.transaction(async tx => {
      const previews = await this.lock(tx, operationId)
      const blocking = previews.filter(preview => preview.status !== 'inactive')
      if (blocking.length > 0) {
        throw new IncusError('Forced destroy requires every capsule preview to be inactive.', 'CONFLICT', {
          operationId,
          previewIds: blocking.map(preview => preview.id),
        })
      }
    })
  }

  private async lock(tx: PreviewTransaction<TDatabase>, operationId: string): Promise<PreviewRecord[]> {
    const { capsules, capsuleOperations, capsuleBranches, capsuleBranchPreviews } = this.persistence.tables
    const [candidate] = await tx
      .select({
        capsuleId: capsuleOperations.capsuleId,
        ownerId: capsuleOperations.ownerId,
      })
      .from(capsuleOperations)
      .where(eq(capsuleOperations.id, operationId))
      .limit(1)
    if (!candidate) {
      throw new IncusError('Force-destroy operation was not found.', 'NOT_FOUND', { operationId })
    }
    const [capsule] = await tx
      .select()
      .from(capsules)
      .where(and(eq(capsules.id, candidate.capsuleId), eq(capsules.ownerId, candidate.ownerId)))
      .for('update')
      .limit(1)
    const [operation] = await tx
      .select()
      .from(capsuleOperations)
      .where(eq(capsuleOperations.id, operationId))
      .for('update')
      .limit(1)
    if (
      !capsule ||
      !operation ||
      operation.ownerId !== capsule.ownerId ||
      operation.capsuleId !== capsule.id ||
      operation.type !== 'destroy' ||
      operation.status !== 'running' ||
      operation.actorType !== 'user' ||
      !operation.destroyForce ||
      !operation.destroyForceAcknowledged ||
      operation.destroyForceReason === null ||
      operation.destroyForceReason.length < 1 ||
      operation.destroyForceReason.length > 2000 ||
      operation.destroyForceReason !== operation.destroyForceReason.trim() ||
      operation.executionStartedAt === null ||
      operation.providerMutationStartedAt === null ||
      operation.completedAt !== null ||
      operation.failedAt !== null ||
      operation.failureCode !== null ||
      operation.failureMessage !== null ||
      operation.failureDetails !== null ||
      capsule.lifecycleStatus !== 'destroying' ||
      capsule.destroyedAt !== null
    ) {
      throw new IncusError('Preview recovery requires a running forced destroy with recorded provider intent.', 'CONFLICT', {
        operationId,
      })
    }
    const branches = await tx
      .select({
        id: capsuleBranches.id,
        ownerId: capsuleBranches.ownerId,
        status: capsuleBranches.status,
      })
      .from(capsuleBranches)
      .where(eq(capsuleBranches.capsuleId, capsule.id))
      .orderBy(asc(capsuleBranches.id))
      .for('update')
    if (
      branches.some(
        branch =>
          branch.ownerId !== capsule.ownerId ||
          (branch.status !== 'destroying' && branch.status !== 'destroyed'),
      )
    ) {
      throw new IncusError('Force-destroy preview recovery requires a fenced capsule branch lineage.', 'CONFLICT', {
        operationId,
        capsuleId: capsule.id,
      })
    }
    const branchIds = branches.map(branch => branch.id)
    const previews = await tx
      .select()
      .from(capsuleBranchPreviews)
      .where(
        or(
          eq(capsuleBranchPreviews.capsuleId, capsule.id),
          branchIds.length === 0 ? undefined : inArray(capsuleBranchPreviews.branchId, branchIds),
        ),
      )
      .orderBy(
        asc(capsuleBranchPreviews.branchId),
        asc(capsuleBranchPreviews.applicationName),
        asc(capsuleBranchPreviews.id),
      )
      .for('update')
    const ownedBranches = new Set(branchIds)
    if (
      previews.some(
        preview =>
          preview.ownerId !== capsule.ownerId ||
          preview.capsuleId !== capsule.id ||
          !ownedBranches.has(preview.branchId),
      )
    ) {
      throw new IncusError('Force-destroy preview ownership does not match the locked capsule lineage.', 'CONFLICT', {
        operationId,
        capsuleId: capsule.id,
      })
    }
    return previews
  }

  private current(records: readonly PreviewRecord[], observed: PreviewRecord): PreviewRecord {
    const preview = records.find(record => record.id === observed.id)
    if (!preview || !this.matches(preview, observed)) {
      throw new IncusError('Preview state changed during force-destroy withdrawal.', 'CONFLICT', {
        previewId: observed.id,
      })
    }
    return preview
  }

  private matches(current: PreviewRecord, observed: PreviewRecord): boolean {
    return (
      current.ownerId === observed.ownerId &&
      current.capsuleId === observed.capsuleId &&
      current.branchId === observed.branchId &&
      current.status === observed.status &&
      current.updatedAt.getTime() === observed.updatedAt.getTime() &&
      current.currentConfigurationDigest === observed.currentConfigurationDigest &&
      current.pendingConfigurationDigest === observed.pendingConfigurationDigest
    )
  }

  private require(record: PreviewRecord | undefined, operationId: string, previewId: string): PreviewRecord {
    if (!record) {
      throw new IncusError('Force-destroy preview transition conflicted with another update.', 'CONFLICT', {
        operationId,
        previewId,
      })
    }
    return record
  }
}
