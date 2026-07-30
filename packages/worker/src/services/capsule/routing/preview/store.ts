import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  CapsuleBranchPreviewListOutputSchema,
  CapsuleOperationStatus,
  CapsuleRouteConfigurationKeySchema,
  CapsuleRouteVerificationEvidenceSchema,
  digestCapsuleRouteConfiguration,
  verifyCapsuleRouteApplicationPin,
  type CapsuleBranchPreviewListOutput,
  type CapsulePersistence,
  type CapsuleRouteApplicationPin,
  type CapsuleRouteVerificationEvidence,
  type CapsuleTables,
} from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError, isUniqueConstraintViolation } from '../../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from '../../failures'
import { toJsonObject } from '../../persistence/json'
import { toIsoTimestamp } from '../../operations/shared'
import type { PreviewBranch, PreviewIdentity, PreviewPlan, PreviewRecord } from './types'

const NONTERMINAL_OPERATION_STATUSES = [CapsuleOperationStatus.ACCEPTED, CapsuleOperationStatus.RUNNING] as const

const APPLYABLE_STATUSES = ['inactive', 'active', 'degraded', 'verifying'] as const
const ACTIVATABLE_STATUSES = ['verifying', 'degraded'] as const
const DEGRADEABLE_STATUSES = ['active', 'degraded', 'verifying'] as const
const REMOVABLE_STATUSES = ['active', 'degraded', 'verifying'] as const
const INACTIVE_STATUSES = ['inactive', 'applying', 'verifying', 'active', 'degraded', 'removing'] as const

type Transaction<TDatabase extends PostgresJsDatabase> = Parameters<Parameters<TDatabase['transaction']>[0]>[0]

export class PreviewStore<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly persistence: CapsulePersistence<TDatabase, TTables>) {}

  public async branches(): Promise<PreviewBranch[]> {
    const { capsules, capsuleBranches, capsuleOperations } = this.persistence.tables
    const [branches, operations] = await Promise.all([
      this.persistence.db
        .select({
          id: capsuleBranches.id,
          ownerId: capsuleBranches.ownerId,
          capsuleId: capsuleBranches.capsuleId,
          name: capsuleBranches.name,
          status: capsuleBranches.status,
          runtimeIp: capsuleBranches.runtimeIp,
          lifecycleStatus: capsules.lifecycleStatus,
          archivedAt: capsules.archivedAt,
        })
        .from(capsuleBranches)
        .innerJoin(capsules, eq(capsules.id, capsuleBranches.capsuleId))
        .orderBy(asc(capsuleBranches.ownerId), asc(capsuleBranches.id)),
      this.persistence.db
        .select({
          capsuleId: capsuleOperations.capsuleId,
        })
        .from(capsuleOperations)
        .where(inArray(capsuleOperations.status, NONTERMINAL_OPERATION_STATUSES)),
    ])
    const blocked = new Set(operations.map(operation => operation.capsuleId))
    return branches.map(branch => ({
      ...branch,
      operationBlocked: blocked.has(branch.capsuleId),
    }))
  }

  public async all(): Promise<PreviewRecord[]> {
    const previews = this.persistence.tables.capsuleBranchPreviews
    return await this.persistence.db
      .select()
      .from(previews)
      .orderBy(asc(previews.ownerId), asc(previews.branchId), asc(previews.applicationName))
  }

  public async list(ownerId: string, capsuleId: string): Promise<CapsuleBranchPreviewListOutput> {
    const previews = this.persistence.tables.capsuleBranchPreviews
    const records = await this.persistence.db
      .select()
      .from(previews)
      .where(and(eq(previews.ownerId, ownerId), eq(previews.capsuleId, capsuleId)))
      .orderBy(asc(previews.createdAt), asc(previews.id))
    return CapsuleBranchPreviewListOutputSchema.parse(
      records.map(record => ({
        id: record.id,
        capsuleId: record.capsuleId,
        branchId: record.branchId,
        applicationName: record.applicationName,
        host: record.host,
        status: record.status,
        application: verifyCapsuleRouteApplicationPin(record.applicationPin),
        verifiedAt:
          record.verifiedAt === null
            ? null
            : toIsoTimestamp(record.verifiedAt, 'verifiedAt', {
                entity: 'branch preview',
                entityId: record.id,
              }),
        createdAt: toIsoTimestamp(record.createdAt, 'createdAt', {
          entity: 'branch preview',
          entityId: record.id,
        }),
        updatedAt: toIsoTimestamp(record.updatedAt, 'updatedAt', {
          entity: 'branch preview',
          entityId: record.id,
        }),
      })),
    )
  }

  public async requestWithdrawal(ownerId: string, capsuleId: string, branchId: string): Promise<PreviewRecord[]> {
    return await this.persistence.db.transaction(async tx => {
      const records = await this.lockBranchPreviews(tx, ownerId, capsuleId, branchId)

      if (records.length === 0) {
        return records
      }

      const previewIds = records.filter(preview => preview.withdrawalRequestedAt === null).map(preview => preview.id)

      if (previewIds.length === 0) {
        return records
      }

      const previews = this.persistence.tables.capsuleBranchPreviews
      const now = new Date()

      await tx
        .update(previews)
        .set({
          withdrawalRequestedAt: now,
          updatedAt: now,
        })
        .where(inArray(previews.id, previewIds))

      return await this.lockBranchPreviews(tx, ownerId, capsuleId, branchId)
    })
  }

  public async resume(ownerId: string, capsuleId: string, branchId: string): Promise<void> {
    await this.persistence.db.transaction(async tx => {
      const records = await this.lockBranchPreviews(tx, ownerId, capsuleId, branchId)

      if (records.length === 0 || records.every(preview => preview.withdrawalRequestedAt === null)) {
        return
      }

      const previews = this.persistence.tables.capsuleBranchPreviews

      await tx
        .update(previews)
        .set({
          withdrawalRequestedAt: null,
          updatedAt: new Date(),
        })
        .where(
          inArray(
            previews.id,
            records.map(preview => preview.id),
          ),
        )
    })
  }

  public async ensure(
    branch: PreviewBranch,
    application: CapsuleRouteApplicationPin,
    identity: PreviewIdentity,
  ): Promise<PreviewRecord> {
    const existing = await this.find(branch.id, application.application.name)
    if (existing) {
      this.assertIdentity(existing, branch, application, identity)
      return existing
    }
    const previews = this.persistence.tables.capsuleBranchPreviews
    try {
      const [created] = await this.persistence.db
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
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning()

      if (!created) {
        throw new IncusError('Failed to create durable branch preview state.', 'API_ERROR', {
          branchId: branch.id,
          applicationName: application.application.name,
        })
      }

      return created
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error
      }

      const raced = await this.find(branch.id, application.application.name)
      if (!raced) {
        throw new IncusError('Branch preview was created concurrently but could not be reloaded.', 'API_ERROR', {
          branchId: branch.id,
          applicationName: application.application.name,
        })
      }

      this.assertIdentity(raced, branch, application, identity)
      return raced
    }
  }

  public async branch(branchId: string) {
    const branches = this.persistence.tables.capsuleBranches
    const [branch] = await this.persistence.db
      .select({
        id: branches.id,
        ownerId: branches.ownerId,
        capsuleId: branches.capsuleId,
        name: branches.name,
        isRootBranch: branches.isRootBranch,
        blueprintName: branches.blueprintName,
        blueprintDigest: branches.blueprintDigest,
        cpu: branches.cpu,
        memory: branches.memory,
        resourceInventoryDigest: branches.resourceInventoryDigest,
      })
      .from(branches)
      .where(eq(branches.id, branchId))
      .limit(1)

    if (!branch) {
      throw new IncusError('Preview branch was not found.', 'NOT_FOUND', {
        branchId,
      })
    }

    return branch
  }

  /**
   * Persists Caddy apply intent only after the current branch and capsule state
   * are revalidated under row locks. The pending configuration remains distinct
   * from the last confirmed current configuration until Caddy readback proves
   * the replacement took effect.
   */
  public async apply(id: string, plan: PreviewPlan): Promise<PreviewRecord> {
    return await this.persistence.db.transaction(async tx => {
      await this.assertApplyEligibility(tx, plan)
      const preview = await this.lockPreview(tx, id)
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
        .where(and(eq(previews.id, id), eq(previews.status, preview.status)))
        .returning()

      return this.requireTransition(record, id, 'applying')
    })
  }

  /**
   * Promotes a pending Caddy configuration into the confirmed current state
   * after route-array readback proves that Caddy contains the intended route.
   */
  public async applied(id: string): Promise<PreviewRecord> {
    return await this.persistence.db.transaction(async tx => {
      const preview = await this.lockPreview(tx, id)
      if (preview.status !== 'applying') {
        throw new IncusError('Branch preview is not waiting for Caddy application confirmation.', 'CONFLICT', {
          previewId: id,
          status: preview.status,
        })
      }

      const pending = this.pending(preview, id)
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
        .where(and(eq(previews.id, id), eq(previews.status, 'applying')))
        .returning()

      return this.requireTransition(record, id, 'verifying')
    })
  }

  public async active(id: string, evidence: CapsuleRouteVerificationEvidence): Promise<PreviewRecord> {
    return await this.persistence.db.transaction(async tx => {
      const preview = await this.lockPreview(tx, id)
      if (!ACTIVATABLE_STATUSES.includes(preview.status as (typeof ACTIVATABLE_STATUSES)[number])) {
        throw new IncusError('Branch preview is not waiting for route verification.', 'CONFLICT', {
          previewId: id,
          status: preview.status,
        })
      }

      const current = this.current(preview, id)
      const verified = CapsuleRouteVerificationEvidenceSchema.parse(evidence)
      if (verified.configurationDigest !== current.configurationDigest) {
        throw new IncusError(
          'Branch preview verification evidence does not match its current configuration.',
          'CONFLICT',
          {
            previewId: id,
            expectedConfigurationDigest: current.configurationDigest,
            actualConfigurationDigest: verified.configurationDigest,
          },
        )
      }

      const previews = this.persistence.tables.capsuleBranchPreviews
      const verifiedAt = new Date(verified.verifiedAt)
      const [record] = await tx
        .update(previews)
        .set({
          status: 'active',
          verificationEvidence: verified,
          verifiedAt,
          failureCode: null,
          failureMessage: null,
          failureDetails: null,
          failureAt: null,
          updatedAt: verifiedAt,
        })
        .where(and(eq(previews.id, id), inArray(previews.status, ACTIVATABLE_STATUSES)))
        .returning()

      return this.requireTransition(record, id, 'active')
    })
  }

  public async degraded(id: string, error: unknown, context: Record<string, unknown>): Promise<PreviewRecord> {
    return await this.persistence.db.transaction(async tx => {
      const preview = await this.lockPreview(tx, id)
      if (!DEGRADEABLE_STATUSES.includes(preview.status as (typeof DEGRADEABLE_STATUSES)[number])) {
        throw new IncusError('Branch preview cannot enter degraded state from its current status.', 'CONFLICT', {
          previewId: id,
          status: preview.status,
        })
      }

      this.current(preview, id)

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
          failureCode: failureCodeFromUnknown(error),
          failureMessage: failureMessageFromUnknown(error, 'Branch preview verification failed.'),
          failureDetails: toJsonObject(details, 'branch preview degraded details'),
          failureAt: now,
          updatedAt: now,
        })
        .where(and(eq(previews.id, id), eq(previews.status, preview.status)))
        .returning()

      return this.requireTransition(record, id, 'degraded')
    })
  }

  /**
   * Handles a Caddy mutation that Caddy positively rejected before applying.
   *
   * A replacement rejection retains the current known route as degraded. An
   * initial create rejection returns to inactive because no current route was
   * ever proven.
   */
  public async rejectApply(id: string, error: unknown, context: Record<string, unknown>): Promise<PreviewRecord> {
    return await this.persistence.db.transaction(async tx => {
      const preview = await this.lockPreview(tx, id)
      if (preview.status !== 'applying') {
        throw new IncusError('Branch preview is not waiting for Caddy application.', 'CONFLICT', {
          previewId: id,
          status: preview.status,
        })
      }

      this.pending(preview, id)

      if (preview.currentRuntimeIp === null) {
        return await this.inactiveInTransaction(tx, preview)
      }

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
        .where(and(eq(previews.id, id), eq(previews.status, 'applying')))
        .returning()

      return this.requireTransition(record, id, 'degraded')
    })
  }

  /**
   * Persists Caddy removal intent while retaining the last confirmed current
   * configuration until route-array readback proves it no longer exists.
   */
  public async removing(id: string): Promise<PreviewRecord> {
    return await this.persistence.db.transaction(async tx => {
      const preview = await this.lockPreview(tx, id)
      await this.assertRelationships(tx, preview)

      if (!REMOVABLE_STATUSES.includes(preview.status as (typeof REMOVABLE_STATUSES)[number])) {
        throw new IncusError('Branch preview cannot begin removal from its current status.', 'CONFLICT', {
          previewId: id,
          status: preview.status,
        })
      }

      this.current(preview, id)

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
        .where(and(eq(previews.id, id), eq(previews.status, preview.status)))
        .returning()

      return this.requireTransition(record, id, 'removing')
    })
  }

  /**
   * Handles a Caddy removal that Caddy positively rejected before removing the
   * current known route.
   */
  public async rejectRemoval(id: string, error: unknown, context: Record<string, unknown>): Promise<PreviewRecord> {
    return await this.persistence.db.transaction(async tx => {
      const preview = await this.lockPreview(tx, id)
      if (preview.status !== 'removing') {
        throw new IncusError('Branch preview is not waiting for Caddy removal.', 'CONFLICT', {
          previewId: id,
          status: preview.status,
        })
      }

      this.current(preview, id)

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
        .where(and(eq(previews.id, id), eq(previews.status, 'removing')))
        .returning()

      return this.requireTransition(record, id, 'degraded')
    })
  }

  /**
   * Clears all route authority only after the caller positively proves that
   * Caddy no longer contains the preview route.
   */
  public async inactive(id: string): Promise<PreviewRecord> {
    return await this.persistence.db.transaction(async tx => {
      const preview = await this.lockPreview(tx, id)
      if (!INACTIVE_STATUSES.includes(preview.status as (typeof INACTIVE_STATUSES)[number])) {
        throw new IncusError('Branch preview cannot become inactive from its current status.', 'CONFLICT', {
          previewId: id,
          status: preview.status,
        })
      }

      return await this.inactiveInTransaction(tx, preview)
    })
  }

  public async cleanup(id: string, error: unknown, context: Record<string, unknown>): Promise<PreviewRecord> {
    const previews = this.persistence.tables.capsuleBranchPreviews
    const now = new Date()
    const details = createFailureDetails(error, context) ?? {
      context,
    }
    const [record] = await this.persistence.db
      .update(previews)
      .set({
        status: 'cleanup_required',
        failureCode: failureCodeFromUnknown(error),
        failureMessage: failureMessageFromUnknown(error, 'Branch preview requires manual cleanup.'),
        failureDetails: toJsonObject(details, 'branch preview cleanup-required details'),
        failureAt: now,
        updatedAt: now,
      })
      .where(eq(previews.id, id))
      .returning()

    return this.requireTransition(record, id, 'cleanup_required')
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

  private async lockPreview(tx: Transaction<TDatabase>, id: string): Promise<PreviewRecord> {
    const previews = this.persistence.tables.capsuleBranchPreviews
    const [preview] = await tx.select().from(previews).where(eq(previews.id, id)).for('update').limit(1)
    if (!preview) {
      throw new IncusError('Branch preview was not found.', 'NOT_FOUND', {
        previewId: id,
      })
    }
    return preview
  }

  private async lockBranchPreviews(
    tx: Transaction<TDatabase>,
    ownerId: string,
    capsuleId: string,
    branchId: string,
  ): Promise<PreviewRecord[]> {
    const previews = this.persistence.tables.capsuleBranchPreviews
    const records = await tx
      .select()
      .from(previews)
      .where(eq(previews.branchId, branchId))
      .orderBy(asc(previews.applicationName), asc(previews.id))
      .for('update')
    for (const preview of records) {
      if (preview.ownerId === ownerId && preview.capsuleId === capsuleId) {
        continue
      }
      throw new IncusError('Branch preview does not match its requested capsule ownership.', 'CONFLICT', {
        previewId: preview.id,
        branchId,
        ownerId,
        capsuleId,
        previewOwnerId: preview.ownerId,
        previewCapsuleId: preview.capsuleId,
      })
    }
    return records
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
    if (preview.pendingRuntimeIp !== null) {
      throw new IncusError('Branch preview already has unresolved pending Caddy configuration.', 'CONFLICT', {
        previewId: preview.id,
        status: preview.status,
      })
    }
  }

  private async assertApplyEligibility(tx: Transaction<TDatabase>, plan: PreviewPlan): Promise<void> {
    const { capsuleBranches, capsuleOperations, capsules } = this.persistence.tables
    const [capsule] = await tx
      .select({
        id: capsules.id,
        ownerId: capsules.ownerId,
        lifecycleStatus: capsules.lifecycleStatus,
        archivedAt: capsules.archivedAt,
      })
      .from(capsules)
      .where(eq(capsules.id, plan.capsuleId))
      .for('update')
      .limit(1)
    if (
      !capsule ||
      capsule.ownerId !== plan.ownerId ||
      capsule.lifecycleStatus !== 'active' ||
      capsule.archivedAt !== null
    ) {
      throw new IncusError('Branch preview capsule is no longer active and unarchived.', 'CONFLICT', {
        capsuleId: plan.capsuleId,
        ownerId: plan.ownerId,
        lifecycleStatus: capsule?.lifecycleStatus ?? null,
        archived: capsule ? capsule.archivedAt !== null : null,
      })
    }

    const [branch] = await tx
      .select({
        id: capsuleBranches.id,
        ownerId: capsuleBranches.ownerId,
        capsuleId: capsuleBranches.capsuleId,
        status: capsuleBranches.status,
        runtimeIp: capsuleBranches.runtimeIp,
      })
      .from(capsuleBranches)
      .where(eq(capsuleBranches.id, plan.branchId))
      .for('update')
      .limit(1)
    if (
      !branch ||
      branch.ownerId !== plan.ownerId ||
      branch.capsuleId !== plan.capsuleId ||
      branch.status !== 'online' ||
      branch.runtimeIp === null ||
      branch.runtimeIp !== plan.runtimeIp
    ) {
      throw new IncusError('Branch preview source branch is no longer eligible for Caddy application.', 'CONFLICT', {
        previewId: plan.previewId,
        branchId: plan.branchId,
        branchStatus: branch?.status ?? null,
        branchRuntimeIp: branch?.runtimeIp ?? null,
        plannedRuntimeIp: plan.runtimeIp,
      })
    }

    const [operation] = await tx
      .select({
        id: capsuleOperations.id,
        type: capsuleOperations.type,
        status: capsuleOperations.status,
      })
      .from(capsuleOperations)
      .where(
        and(
          eq(capsuleOperations.capsuleId, plan.capsuleId),
          inArray(capsuleOperations.status, NONTERMINAL_OPERATION_STATUSES),
        ),
      )
      .limit(1)
    if (operation) {
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
  }

  private async assertRelationships(tx: Transaction<TDatabase>, preview: PreviewRecord): Promise<void> {
    const { capsuleBranches, capsules } = this.persistence.tables
    const [capsule] = await tx
      .select({
        ownerId: capsules.ownerId,
      })
      .from(capsules)
      .where(eq(capsules.id, preview.capsuleId))
      .for('update')
      .limit(1)
    const [branch] = await tx
      .select({
        ownerId: capsuleBranches.ownerId,
        capsuleId: capsuleBranches.capsuleId,
      })
      .from(capsuleBranches)
      .where(eq(capsuleBranches.id, preview.branchId))
      .for('update')
      .limit(1)
    if (
      !capsule ||
      !branch ||
      capsule.ownerId !== preview.ownerId ||
      branch.ownerId !== preview.ownerId ||
      branch.capsuleId !== preview.capsuleId
    ) {
      throw new IncusError('Branch preview no longer matches its durable capsule and branch ownership.', 'CONFLICT', {
        previewId: preview.id,
        ownerId: preview.ownerId,
        capsuleId: preview.capsuleId,
        branchId: preview.branchId,
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

  private current(preview: PreviewRecord, previewId: string) {
    if (
      preview.currentRuntimeIp === null ||
      preview.currentConfigurationKey === null ||
      preview.currentConfigurationDigest === null ||
      preview.currentConfiguration === null ||
      preview.appliedAt === null
    ) {
      throw new IncusError('Branch preview has no confirmed current Caddy configuration.', 'CONFLICT', {
        previewId,
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

  private pending(preview: PreviewRecord, previewId: string) {
    if (
      preview.pendingRuntimeIp === null ||
      preview.pendingConfigurationKey === null ||
      preview.pendingConfigurationDigest === null ||
      preview.pendingConfiguration === null ||
      preview.applyIntentAt === null
    ) {
      throw new IncusError('Branch preview has no pending Caddy configuration.', 'CONFLICT', {
        previewId,
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

  private async inactiveInTransaction(tx: Transaction<TDatabase>, preview: PreviewRecord): Promise<PreviewRecord> {
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
      .where(and(eq(previews.id, preview.id), eq(previews.status, preview.status)))
      .returning()

    return this.requireTransition(record, preview.id, 'inactive')
  }

  private requireTransition(record: PreviewRecord | undefined, previewId: string, status: string): PreviewRecord {
    if (!record) {
      throw new IncusError(`Failed to transition branch preview to '${status}'.`, 'CONFLICT', {
        previewId,
        status,
      })
    }
    return record
  }
}
