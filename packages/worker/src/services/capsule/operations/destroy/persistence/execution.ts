import { and, asc, eq, isNull } from 'drizzle-orm'
import { CapsuleOperationStatus, CapsuleOperationType, type QilnPersistence, type QilnTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError } from '../../../../../errors'
import {
  toCapsuleOperationTransition,
  type CapsuleOperationReader,
  type CapsuleOperationTransitionOutput,
} from '../../shared'
import { assertDestroyingCapsuleBranchLineage } from '../policy/lineage'
import type { DestroyCapsuleAcceptedBranch, DestroyCapsuleExecutionInput } from '../types'

/**
 * Owns PostgreSQL-authoritative destroy execution input and execution fences.
 *
 * The executor receives only an operation ID. This boundary reloads all
 * immutable execution identity and aggregate state before allowing the
 * accepted-to-running transition or provider-intent commitment.
 */
export class DestroyCapsuleExecutionPersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends QilnTables = QilnTables,
> {
  constructor(
    private readonly persistence: QilnPersistence<TDatabase, TTables>,
    private readonly reader: CapsuleOperationReader<TDatabase, TTables>,
  ) {}

  public async loadAcceptedExecutionInput(operationId: string): Promise<DestroyCapsuleExecutionInput> {
    const operation = await this.reader.loadById(operationId)
    if (!operation) {
      throw new IncusError('Capsule destroy operation was not found.', 'NOT_FOUND', {
        operationId,
      })
    }
    if (operation.type !== CapsuleOperationType.DESTROY) {
      throw new IncusError('Operation is not a capsule destroy operation.', 'CONFLICT', {
        operationId,
        operationType: operation.type,
      })
    }
    if (operation.status !== CapsuleOperationStatus.ACCEPTED) {
      throw new IncusError('Capsule destroy operation is no longer accepted for execution.', 'CONFLICT', {
        operationId,
        operationStatus: operation.status,
      })
    }
    if (operation.providerMutationStartedAt !== null) {
      throw new IncusError('Accepted capsule destroy operation already contains provider intent.', 'CONFLICT', {
        operationId,
        providerMutationStartedAt: operation.providerMutationStartedAt.toISOString(),
      })
    }
    const db = this.persistence.db
    const capsules = this.persistence.tables.capsules
    const [capsule] = await db
      .select({
        lifecycleStatus: capsules.lifecycleStatus,
        archivedAt: capsules.archivedAt,
      })
      .from(capsules)
      .where(and(eq(capsules.id, operation.capsuleId), eq(capsules.ownerId, operation.ownerId)))
      .limit(1)
    if (!capsule || capsule.lifecycleStatus !== 'destroying' || capsule.archivedAt === null) {
      throw new IncusError('Capsule destroy aggregate does not match its accepted destroy fence.', 'CONFLICT', {
        operationId,
        capsuleId: operation.capsuleId,
        lifecycleStatus: capsule?.lifecycleStatus ?? null,
        archived: capsule ? capsule.archivedAt !== null : null,
      })
    }
    const branches = await this.loadAcceptedBranches(operation.ownerId, operation.capsuleId)

    assertDestroyingCapsuleBranchLineage(operation.ownerId, operation.capsuleId, branches)

    return {
      operationId: operation.id,
      ownerId: operation.ownerId,
      capsuleId: operation.capsuleId,
      branches,
    }
  }

  /**
   * Claims one accepted destroy operation for process-local execution.
   *
   * A destroy operation is capsule-scoped. Absence of provider intent is part
   * of the compare-and-set fence.
   */
  public async claimAccepted(operationId: string): Promise<CapsuleOperationTransitionOutput> {
    const db = this.persistence.db
    const operations = this.persistence.tables.capsuleOperations
    const now = new Date()
    const [claimed] = await db
      .update(operations)
      .set({
        status: CapsuleOperationStatus.RUNNING,
        executionStartedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(operations.id, operationId),
          eq(operations.type, CapsuleOperationType.DESTROY),
          eq(operations.status, CapsuleOperationStatus.ACCEPTED),
          isNull(operations.providerMutationStartedAt),
        ),
      )
      .returning({
        ownerId: operations.ownerId,
        capsuleId: operations.capsuleId,
        status: operations.status,
      })
    if (!claimed) {
      throw new IncusError('Capsule destroy operation could not be claimed from accepted to running.', 'CONFLICT', {
        operationId,
      })
    }
    return toCapsuleOperationTransition({
      ownerId: claimed.ownerId,
      operationId,
      operationType: CapsuleOperationType.DESTROY,
      operationStatus: claimed.status,
      capsuleId: claimed.capsuleId,
    })
  }

  /**
   * Commits the operation-wide provider-intent fence.
   *
   * This compare-and-set must complete before any instance stop, instance
   * deletion, volume deletion, or other provider mutation.
   */
  public async commitProviderIntentFence(operationId: string): Promise<void> {
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
          eq(operations.type, CapsuleOperationType.DESTROY),
          eq(operations.status, CapsuleOperationStatus.RUNNING),
          isNull(operations.providerMutationStartedAt),
        ),
      )
      .returning({
        id: operations.id,
      })
    if (updated.length !== 1) {
      throw new IncusError('Failed to commit the capsule destroy provider-intent fence.', 'CONFLICT', {
        operationId,
      })
    }
  }

  private async loadAcceptedBranches(ownerId: string, capsuleId: string): Promise<DestroyCapsuleAcceptedBranch[]> {
    const db = this.persistence.db
    const branches = this.persistence.tables.capsuleBranches
    return await db
      .select({
        id: branches.id,
        capsuleId: branches.capsuleId,
        ownerId: branches.ownerId,
        name: branches.name,
        status: branches.status,
        isRootBranch: branches.isRootBranch,
        resourceInventoryDigest: branches.resourceInventoryDigest,
      })
      .from(branches)
      .where(and(eq(branches.ownerId, ownerId), eq(branches.capsuleId, capsuleId)))
      .orderBy(asc(branches.id))
  }
}
