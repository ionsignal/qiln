import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  capsuleOperationsTable,
  capsuleSnapshotCaptureResourcesTable,
  type CapsuleHostDbContract,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from '../../../failures'
import { toJsonObject } from '../../../persistence/json'
import type { CaptureResourceRecord, CaptureRootPlan } from '../types'

const COMPENSATED_RESOURCE_STATUSES = ['deleted', 'missing'] as const

function toResource(resource: typeof capsuleSnapshotCaptureResourcesTable.$inferSelect): CaptureResourceRecord {
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
export class CaptureResourcePersistence {
  constructor(private readonly db: CapsuleHostDbContract) {}

  public async list(operationId: string): Promise<CaptureResourceRecord[]> {
    const resources = await this.db
      .select()
      .from(capsuleSnapshotCaptureResourcesTable)
      .where(eq(capsuleSnapshotCaptureResourcesTable.operationId, operationId))
      .orderBy(asc(capsuleSnapshotCaptureResourcesTable.artifactRootId), asc(capsuleSnapshotCaptureResourcesTable.id))

    return resources.map(toResource)
  }

  /**
   * Commits per-resource creation intent after the operation-wide provider
   * fence has already committed.
   */
  public async creating(operationId: string, root: CaptureRootPlan): Promise<CaptureResourceRecord> {
    return await this.db.transaction(async tx => {
      const [operation] = await tx
        .select({
          status: capsuleOperationsTable.status,
          providerMutationStartedAt: capsuleOperationsTable.providerMutationStartedAt,
        })
        .from(capsuleOperationsTable)
        .where(
          and(
            eq(capsuleOperationsTable.id, operationId),
            eq(capsuleOperationsTable.type, CapsuleOperationType.SNAPSHOT_CAPTURE),
          ),
        )
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
        .update(capsuleSnapshotCaptureResourcesTable)
        .set({
          status: 'creating',
          snapshotIntentAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleSnapshotCaptureResourcesTable.operationId, operationId),
            eq(capsuleSnapshotCaptureResourcesTable.artifactRootId, root.artifactRootId),
            eq(capsuleSnapshotCaptureResourcesTable.sourceBranchResourceId, root.sourceBranchResourceId),
            eq(capsuleSnapshotCaptureResourcesTable.blueprintVolumeName, root.blueprintVolumeName),
            eq(capsuleSnapshotCaptureResourcesTable.provider, root.provider),
            eq(capsuleSnapshotCaptureResourcesTable.kind, root.kind),
            eq(capsuleSnapshotCaptureResourcesTable.project, root.project),
            eq(capsuleSnapshotCaptureResourcesTable.pool, root.pool),
            eq(capsuleSnapshotCaptureResourcesTable.sourceVolume, root.sourceVolume),
            eq(capsuleSnapshotCaptureResourcesTable.snapshotName, root.snapshotName),
            eq(capsuleSnapshotCaptureResourcesTable.status, 'planned'),
            isNull(capsuleSnapshotCaptureResourcesTable.snapshotIntentAt),
            isNull(capsuleSnapshotCaptureResourcesTable.snapshotCreatedAt),
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
    const [resource] = await this.db
      .update(capsuleSnapshotCaptureResourcesTable)
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
          eq(capsuleSnapshotCaptureResourcesTable.id, resourceId),
          eq(capsuleSnapshotCaptureResourcesTable.operationId, operationId),
          eq(capsuleSnapshotCaptureResourcesTable.status, 'creating'),
          isNotNull(capsuleSnapshotCaptureResourcesTable.snapshotIntentAt),
          isNull(capsuleSnapshotCaptureResourcesTable.snapshotCreatedAt),
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
    const now = new Date()
    const details = createFailureDetails(error, context) ?? {
      context,
    }
    const [resource] = await this.db
      .update(capsuleSnapshotCaptureResourcesTable)
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
          eq(capsuleSnapshotCaptureResourcesTable.id, resourceId),
          eq(capsuleSnapshotCaptureResourcesTable.operationId, operationId),
          inArray(capsuleSnapshotCaptureResourcesTable.status, ['creating', 'deleting']),
          isNotNull(capsuleSnapshotCaptureResourcesTable.snapshotIntentAt),
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
    const now = new Date()
    const [resource] = await this.db
      .update(capsuleSnapshotCaptureResourcesTable)
      .set({
        status: 'deleting',
        cleanupIntentAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleSnapshotCaptureResourcesTable.id, resourceId),
          eq(capsuleSnapshotCaptureResourcesTable.operationId, operationId),
          eq(capsuleSnapshotCaptureResourcesTable.status, 'created'),
          isNotNull(capsuleSnapshotCaptureResourcesTable.snapshotIntentAt),
          isNotNull(capsuleSnapshotCaptureResourcesTable.snapshotCreatedAt),
          isNull(capsuleSnapshotCaptureResourcesTable.cleanupIntentAt),
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
    const now = new Date()
    const [resource] = await this.db
      .update(capsuleSnapshotCaptureResourcesTable)
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
          eq(capsuleSnapshotCaptureResourcesTable.id, resourceId),
          eq(capsuleSnapshotCaptureResourcesTable.operationId, operationId),
          eq(capsuleSnapshotCaptureResourcesTable.status, 'deleting'),
          isNotNull(capsuleSnapshotCaptureResourcesTable.snapshotIntentAt),
          isNotNull(capsuleSnapshotCaptureResourcesTable.snapshotCreatedAt),
          isNotNull(capsuleSnapshotCaptureResourcesTable.cleanupIntentAt),
          isNull(capsuleSnapshotCaptureResourcesTable.cleanupCompletedAt),
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
