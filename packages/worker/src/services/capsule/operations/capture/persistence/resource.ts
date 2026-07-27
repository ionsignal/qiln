import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from '../../../failures'
import { toJsonObject } from '../../../persistence/json'
import type { CaptureResourceRecord, CaptureRootPlan } from '../types'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

const COMPENSATED_RESOURCE_STATUSES = ['deleted', 'missing'] as const

type CaptureResourceRow = CapsuleTables['capsuleSnapshotCaptureResources']['$inferSelect']

function toResource(resource: CaptureResourceRow): CaptureResourceRecord {
  return {
    id: resource.id,
    operationId: resource.operationId,
    sourceBranchResourceId: resource.sourceBranchResourceId,
    artifactRootId: resource.artifactRootId,
    blueprintVolumeName: resource.blueprintVolumeName,
    provider: resource.provider,
    kind: resource.kind,
    project: resource.project,
    pool: resource.pool,
    sourceVolume: resource.sourceVolume,
    snapshotName: resource.snapshotName,
    status: resource.status,
    snapshotIntentAt: resource.snapshotIntentAt,
    snapshotCreatedAt: resource.snapshotCreatedAt,
    cleanupIntentAt: resource.cleanupIntentAt,
    cleanupCompletedAt: resource.cleanupCompletedAt,
    failureCode: resource.failureCode,
    failureMessage: resource.failureMessage,
    failureDetails: resource.failureDetails,
    failureAt: resource.failureAt,
  }
}

/**
 * Persistence boundary for operation-scoped provider snapshot accounting.
 *
 * These rows describe execution intent and outcomes. They are never committed
 * snapshot history and cannot authorize a future branch fork.
 */
export class CaptureResourcePersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly persistence: CapsulePersistence<TDatabase, TTables>) {}

  public async list(operationId: string): Promise<CaptureResourceRecord[]> {
    const db = this.persistence.db
    const resources = this.persistence.tables.capsuleSnapshotCaptureResources
    const records = await db
      .select()
      .from(resources)
      .where(eq(resources.operationId, operationId))
      .orderBy(asc(resources.artifactRootId), asc(resources.id))
    return records.map(toResource)
  }

  /**
   * Commits per-resource creation intent after the operation-wide provider
   * fence has already committed.
   */
  public async creating(operationId: string, root: CaptureRootPlan): Promise<CaptureResourceRecord> {
    const db = this.persistence.db
    const operations = this.persistence.tables.capsuleOperations
    const resources = this.persistence.tables.capsuleSnapshotCaptureResources
    return await db.transaction(async tx => {
      const [operation] = await tx
        .select({
          status: operations.status,
          providerMutationStartedAt: operations.providerMutationStartedAt,
        })
        .from(operations)
        .where(and(eq(operations.id, operationId), eq(operations.type, CapsuleOperationType.SNAPSHOT_CAPTURE)))
        .for('update')
        .limit(1)
      if (
        !operation ||
        operation.status !== CapsuleOperationStatus.RUNNING ||
        operation.providerMutationStartedAt === null
      ) {
        throw new IncusError(
          'Snapshot Capture resource intent requires a running operation with committed provider intent.',
          'CONFLICT',
          {
            operationId,
            operationStatus: operation?.status ?? null,
            providerIntentCommitted: operation?.providerMutationStartedAt !== null,
          },
        )
      }
      const now = new Date()
      const [resource] = await tx
        .update(resources)
        .set({
          status: 'creating',
          snapshotIntentAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(resources.operationId, operationId),
            eq(resources.artifactRootId, root.artifactRootId),
            eq(resources.sourceBranchResourceId, root.sourceBranchResourceId),
            eq(resources.blueprintVolumeName, root.blueprintVolumeName),
            eq(resources.provider, root.provider),
            eq(resources.kind, root.kind),
            eq(resources.project, root.project),
            eq(resources.pool, root.pool),
            eq(resources.sourceVolume, root.sourceVolume),
            eq(resources.snapshotName, root.snapshotName),
            eq(resources.status, 'planned'),
            isNull(resources.snapshotIntentAt),
            isNull(resources.snapshotCreatedAt),
          ),
        )
        .returning()
      if (!resource) {
        throw new IncusError(
          `Failed to commit provider snapshot intent for artifact root '${root.artifactRootId}'.`,
          'CONFLICT',
          {
            operationId,
            artifactRootId: root.artifactRootId,
          },
        )
      }

      return toResource(resource)
    })
  }

  public async created(operationId: string, resourceId: string): Promise<CaptureResourceRecord> {
    const now = new Date()
    const db = this.persistence.db
    const resources = this.persistence.tables.capsuleSnapshotCaptureResources
    const [resource] = await db
      .update(resources)
      .set({
        status: 'created',
        snapshotCreatedAt: now,
        failureCode: null,
        failureMessage: null,
        failureDetails: null,
        failureAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(resources.id, resourceId),
          eq(resources.operationId, operationId),
          eq(resources.status, 'creating'),
          isNotNull(resources.snapshotIntentAt),
          isNull(resources.snapshotCreatedAt),
        ),
      )
      .returning()
    if (!resource) {
      throw new IncusError('Failed to persist the confirmed provider snapshot creation outcome.', 'CONFLICT', {
        operationId,
        resourceId,
      })
    }
    return toResource(resource)
  }

  /**
   * Records an uncertain or failed provider mutation.
   *
   * A resource in `error` is not eligible for ordinary failure restoration.
   */
  public async error(
    operationId: string,
    resourceId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<CaptureResourceRecord> {
    const db = this.persistence.db
    const resources = this.persistence.tables.capsuleSnapshotCaptureResources
    const now = new Date()
    const details = createFailureDetails(error, context) ?? {
      context,
    }
    const [resource] = await db
      .update(resources)
      .set({
        status: 'error',
        failureCode: failureCodeFromUnknown(error),
        failureMessage: failureMessageFromUnknown(error, 'Snapshot Capture provider resource outcome is uncertain.'),
        failureDetails: toJsonObject(details, 'Snapshot Capture provider resource failure details'),
        failureAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(resources.id, resourceId),
          eq(resources.operationId, operationId),
          inArray(resources.status, ['creating', 'deleting']),
          isNotNull(resources.snapshotIntentAt),
        ),
      )
      .returning()
    if (!resource) {
      throw new IncusError('Failed to persist Snapshot Capture provider resource uncertainty.', 'CONFLICT', {
        operationId,
        resourceId,
      })
    }
    return toResource(resource)
  }

  public async deleting(operationId: string, resourceId: string): Promise<CaptureResourceRecord> {
    const db = this.persistence.db
    const resources = this.persistence.tables.capsuleSnapshotCaptureResources
    const now = new Date()
    const [resource] = await db
      .update(resources)
      .set({
        status: 'deleting',
        cleanupIntentAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(resources.id, resourceId),
          eq(resources.operationId, operationId),
          eq(resources.status, 'created'),
          isNotNull(resources.snapshotIntentAt),
          isNotNull(resources.snapshotCreatedAt),
          isNull(resources.cleanupIntentAt),
        ),
      )
      .returning()
    if (!resource) {
      throw new IncusError('Failed to persist provider snapshot cleanup intent.', 'CONFLICT', {
        operationId,
        resourceId,
      })
    }

    return toResource(resource)
  }

  public async compensated(
    operationId: string,
    resourceId: string,
    outcome: (typeof COMPENSATED_RESOURCE_STATUSES)[number],
  ): Promise<CaptureResourceRecord> {
    const db = this.persistence.db
    const resources = this.persistence.tables.capsuleSnapshotCaptureResources
    const now = new Date()
    const [resource] = await db
      .update(resources)
      .set({
        status: outcome,
        cleanupCompletedAt: now,
        failureCode: null,
        failureMessage: null,
        failureDetails: null,
        failureAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(resources.id, resourceId),
          eq(resources.operationId, operationId),
          eq(resources.status, 'deleting'),
          isNotNull(resources.snapshotIntentAt),
          isNotNull(resources.snapshotCreatedAt),
          isNotNull(resources.cleanupIntentAt),
          isNull(resources.cleanupCompletedAt),
        ),
      )
      .returning()
    if (!resource) {
      throw new IncusError('Failed to persist provider snapshot compensation outcome.', 'CONFLICT', {
        operationId,
        resourceId,
        outcome,
      })
    }

    return toResource(resource)
  }
}
