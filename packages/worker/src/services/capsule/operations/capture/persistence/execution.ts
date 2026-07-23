import { and, eq, isNull } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  capsuleOperationsTable,
  type CapsuleHostDbContract,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { toCapsuleOperationTransition } from '../../shared'
import type { CaptureRunningResult } from '../types'

/**
 * Owns Snapshot Capture execution-state transitions on the base operation.
 *
 * Capture-specific immutable input remains in the capture extension. Provider
 * mutation cannot begin until `intent()` commits the operation-wide fence.
 */
export class CaptureExecutionPersistence {
  constructor(private readonly db: CapsuleHostDbContract) {}

  public async claim(operationId: string): Promise<CaptureRunningResult> {
    const now = new Date()
    const [operation] = await this.db
      .update(capsuleOperationsTable)
      .set({
        status: CapsuleOperationStatus.RUNNING,
        executionStartedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleOperationsTable.id, operationId),
          eq(capsuleOperationsTable.type, CapsuleOperationType.SNAPSHOT_CAPTURE),
          eq(capsuleOperationsTable.status, CapsuleOperationStatus.ACCEPTED),
          isNull(capsuleOperationsTable.providerMutationStartedAt),
        ),
      )
      .returning({
        ownerId: capsuleOperationsTable.ownerId,
        capsuleId: capsuleOperationsTable.capsuleId,
        status: capsuleOperationsTable.status,
      })

    if (!operation) {
      throw new IncusError('Snapshot Capture operation could not be claimed from accepted to running.', 'CONFLICT', {
        operationId,
      })
    }

    return {
      operation: toCapsuleOperationTransition({
        ownerId: operation.ownerId,
        operationId,
        operationType: CapsuleOperationType.SNAPSHOT_CAPTURE,
        operationStatus: operation.status,
        capsuleId: operation.capsuleId,
      }),
    }
  }

  /**
   * Commits the operation-wide provider-intent fence.
   *
   * This compare-and-set must complete before creating any Incus custom-volume
   * snapshot.
   */
  public async intent(operationId: string): Promise<void> {
    const now = new Date()
    const updated = await this.db
      .update(capsuleOperationsTable)
      .set({
        providerMutationStartedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleOperationsTable.id, operationId),
          eq(capsuleOperationsTable.type, CapsuleOperationType.SNAPSHOT_CAPTURE),
          eq(capsuleOperationsTable.status, CapsuleOperationStatus.RUNNING),
          isNull(capsuleOperationsTable.providerMutationStartedAt),
        ),
      )
      .returning({
        id: capsuleOperationsTable.id,
      })

    if (updated.length !== 1) {
      throw new IncusError('Failed to commit the Snapshot Capture provider-intent fence.', 'CONFLICT', {
        operationId,
      })
    }
  }
}
