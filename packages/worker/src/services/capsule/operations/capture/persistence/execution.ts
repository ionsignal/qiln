import { and, eq, isNull } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { toCapsuleOperationTransition } from '../../shared'
import type { CaptureRunningResult } from '../types'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

/**
 * Owns Snapshot Capture execution-state transitions on the base operation.
 *
 * Capture-specific immutable input remains in the capture extension. Provider
 * mutation cannot begin until `intent()` commits the operation-wide fence.
 */
export class CaptureExecutionPersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly persistence: CapsulePersistence<TDatabase, TTables>) {}

  public async claim(operationId: string): Promise<CaptureRunningResult> {
    const db = this.persistence.db
    const operations = this.persistence.tables.capsuleOperations
    const now = new Date()
    const [operation] = await db
      .update(operations)
      .set({
        status: CapsuleOperationStatus.RUNNING,
        executionStartedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(operations.id, operationId),
          eq(operations.type, CapsuleOperationType.SNAPSHOT_CAPTURE),
          eq(operations.status, CapsuleOperationStatus.ACCEPTED),
          isNull(operations.providerMutationStartedAt),
        ),
      )
      .returning({
        ownerId: operations.ownerId,
        capsuleId: operations.capsuleId,
        status: operations.status,
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
    const db = this.persistence.db
    const operations = this.persistence.tables.capsuleOperations
    const now = new Date()
    const updated = await db
      .update(operations)
      .set({
        providerMutationStartedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(operations.id, operationId),
          eq(operations.type, CapsuleOperationType.SNAPSHOT_CAPTURE),
          eq(operations.status, CapsuleOperationStatus.RUNNING),
          isNull(operations.providerMutationStartedAt),
        ),
      )
      .returning({
        id: operations.id,
      })
    if (updated.length !== 1) {
      throw new IncusError('Failed to commit the Snapshot Capture provider-intent fence.', 'CONFLICT', {
        operationId,
      })
    }
  }
}
