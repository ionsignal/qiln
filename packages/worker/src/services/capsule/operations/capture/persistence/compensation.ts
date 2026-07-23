import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  capsuleBranchesTable,
  capsuleOperationsTable,
  capsuleSnapshotCaptureOperationsTable,
  capsuleSnapshotCaptureResourcesTable,
  capsulesTable,
  type CapsuleHostDbContract,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from '../../../failures'
import { toJsonObject } from '../../../persistence/json'
import { toCapsuleLifecycleState, toCapsuleOperationTransition } from '../../shared'
import type { CaptureTerminalResult } from '../types'

const NONTERMINAL_CAPTURE_STATUSES = [CapsuleOperationStatus.ACCEPTED, CapsuleOperationStatus.RUNNING] as const

/**
 * Commits ordinary capture failure after every confirmed-created provider
 * snapshot has been durably proven deleted or missing.
 *
 * This is separate from pre-provider failure classification because a committed
 * provider-intent fence must never be ignored or cleared. The durable resource
 * ledger supplies the proof that compensation completed.
 */
export class CaptureCompensationPersistence {
  constructor(private readonly db: CapsuleHostDbContract) {}

  public async fail(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<CaptureTerminalResult> {
    return await this.db.transaction(async tx => {
      const [operation] = await tx
        .select()
        .from(capsuleOperationsTable)
        .where(
          and(
            eq(capsuleOperationsTable.id, operationId),
            eq(capsuleOperationsTable.type, CapsuleOperationType.SNAPSHOT_CAPTURE),
          ),
        )
        .for('update')
        .limit(1)

      if (!operation) {
        throw new IncusError('Snapshot Capture operation was not found.', 'NOT_FOUND', {
          operationId,
        })
      }

      if (
        !NONTERMINAL_CAPTURE_STATUSES.includes(operation.status as (typeof NONTERMINAL_CAPTURE_STATUSES)[number]) ||
        operation.providerMutationStartedAt === null
      ) {
        throw new IncusError('Snapshot Capture operation is not eligible for compensated failure.', 'CONFLICT', {
          operationId,
          operationStatus: operation.status,
          providerIntentCommitted: operation.providerMutationStartedAt !== null,
        })
      }

      const [extension] = await tx
        .select()
        .from(capsuleSnapshotCaptureOperationsTable)
        .where(eq(capsuleSnapshotCaptureOperationsTable.operationId, operationId))
        .for('update')
        .limit(1)

      if (!extension || extension.snapshotId !== null) {
        throw new IncusError(
          'Compensated Snapshot Capture failure requires an uncommitted capture extension.',
          'CONFLICT',
          {
            operationId,
            snapshotId: extension?.snapshotId ?? null,
          },
        )
      }

      const [capsule] = await tx
        .select()
        .from(capsulesTable)
        .where(and(eq(capsulesTable.id, operation.capsuleId), eq(capsulesTable.ownerId, operation.ownerId)))
        .for('update')
        .limit(1)

      if (!capsule) {
        throw new IncusError('Snapshot Capture capsule was not found.', 'NOT_FOUND', {
          operationId,
          capsuleId: operation.capsuleId,
        })
      }

      const [branch] = await tx
        .select()
        .from(capsuleBranchesTable)
        .where(
          and(
            eq(capsuleBranchesTable.id, extension.sourceBranchId),
            eq(capsuleBranchesTable.ownerId, operation.ownerId),
            eq(capsuleBranchesTable.capsuleId, operation.capsuleId),
          ),
        )
        .for('update')
        .limit(1)

      if (
        !branch ||
        branch.status !== 'capturing' ||
        branch.name !== extension.sourceBranchName ||
        branch.resourceInventoryDigest !== extension.sourceBranchResourceInventoryDigest
      ) {
        throw new IncusError('Snapshot Capture branch fence is inconsistent during compensated failure.', 'CONFLICT', {
          operationId,
          sourceBranchId: extension.sourceBranchId,
          branchStatus: branch?.status ?? null,
        })
      }

      if (capsule.lifecycleStatus !== 'active' || capsule.archivedAt !== null) {
        throw new IncusError('Snapshot Capture capsule is inconsistent during compensated failure.', 'CONFLICT', {
          operationId,
          capsuleId: operation.capsuleId,
          lifecycleStatus: capsule.lifecycleStatus,
          archived: capsule.archivedAt !== null,
        })
      }

      const resources = await tx
        .select()
        .from(capsuleSnapshotCaptureResourcesTable)
        .where(eq(capsuleSnapshotCaptureResourcesTable.operationId, operationId))
        .orderBy(asc(capsuleSnapshotCaptureResourcesTable.artifactRootId), asc(capsuleSnapshotCaptureResourcesTable.id))
        .for('update')

      if (resources.length === 0) {
        throw new IncusError('Compensated Snapshot Capture failure has no provider resource accounting.', 'CONFLICT', {
          operationId,
        })
      }

      const incomplete = resources.filter(
        resource =>
          (resource.status !== 'deleted' && resource.status !== 'missing') ||
          resource.snapshotIntentAt === null ||
          resource.snapshotCreatedAt === null ||
          resource.cleanupIntentAt === null ||
          resource.cleanupCompletedAt === null,
      )

      if (incomplete.length > 0) {
        throw new IncusError('Snapshot Capture provider compensation is incomplete or uncertain.', 'CONFLICT', {
          operationId,
          resources: incomplete.map(resource => ({
            resourceId: resource.id,
            artifactRootId: resource.artifactRootId,
            status: resource.status,
            snapshotIntentAt: resource.snapshotIntentAt,
            snapshotCreatedAt: resource.snapshotCreatedAt,
            cleanupIntentAt: resource.cleanupIntentAt,
            cleanupCompletedAt: resource.cleanupCompletedAt,
          })),
        })
      }

      const details = createFailureDetails(error, {
        ...context,
        classification: 'post_provider_capture_failure_after_complete_compensation',
        providerIntentCommitted: true,
        compensationComplete: true,
        resourceCount: resources.length,
      })
      const now = new Date()

      const [failedOperation] = await tx
        .update(capsuleOperationsTable)
        .set({
          status: CapsuleOperationStatus.FAILED,
          failedAt: now,
          failureCode: failureCodeFromUnknown(error),
          failureMessage: failureMessageFromUnknown(
            error,
            'Snapshot Capture failed after complete provider compensation.',
          ),
          failureDetails:
            details === undefined ? undefined : toJsonObject(details, 'Snapshot Capture compensated failure details'),
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleOperationsTable.id, operationId),
            eq(capsuleOperationsTable.type, CapsuleOperationType.SNAPSHOT_CAPTURE),
            inArray(capsuleOperationsTable.status, NONTERMINAL_CAPTURE_STATUSES),
            isNotNull(capsuleOperationsTable.providerMutationStartedAt),
          ),
        )
        .returning({
          id: capsuleOperationsTable.id,
        })

      const [offlineBranch] = await tx
        .update(capsuleBranchesTable)
        .set({
          status: 'offline',
          runtimeIp: null,
          runtimeErrorCode: null,
          runtimeErrorMessage: null,
          runtimeErrorDetails: null,
          runtimeErrorAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleBranchesTable.id, branch.id),
            eq(capsuleBranchesTable.ownerId, operation.ownerId),
            eq(capsuleBranchesTable.capsuleId, operation.capsuleId),
            eq(capsuleBranchesTable.status, 'capturing'),
          ),
        )
        .returning({
          id: capsuleBranchesTable.id,
          capsuleId: capsuleBranchesTable.capsuleId,
          name: capsuleBranchesTable.name,
          status: capsuleBranchesTable.status,
        })

      if (!failedOperation || !offlineBranch) {
        throw new IncusError('Failed to atomically finalize compensated Snapshot Capture failure.', 'CONFLICT', {
          operationId,
          capsuleId: operation.capsuleId,
          sourceBranchId: branch.id,
        })
      }

      return {
        operation: toCapsuleOperationTransition({
          ownerId: operation.ownerId,
          operationId,
          operationType: CapsuleOperationType.SNAPSHOT_CAPTURE,
          operationStatus: CapsuleOperationStatus.FAILED,
          capsuleId: operation.capsuleId,
        }),
        capsule: toCapsuleLifecycleState({
          capsuleId: operation.capsuleId,
          lifecycleStatus: capsule.lifecycleStatus,
          archivedAt: capsule.archivedAt,
          destroyedAt: capsule.destroyedAt,
        }),
        branches: [offlineBranch],
      }
    })
  }
}
