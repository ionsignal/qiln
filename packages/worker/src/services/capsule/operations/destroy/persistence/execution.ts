import { and, asc, eq, isNull } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  capsuleBranchesTable,
  capsuleOperationsTable,
  capsulesTable,
  type CapsuleHostDbContract,
} from '@qiln/core/server'
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
export class DestroyCapsuleExecutionPersistence {
  constructor(
    private readonly db: CapsuleHostDbContract,
    private readonly reader: CapsuleOperationReader,
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
    const [capsule] = await this.db
      .select({
        lifecycleStatus: capsulesTable.lifecycleStatus,
        archivedAt: capsulesTable.archivedAt,
      })
      .from(capsulesTable)
      .where(and(eq(capsulesTable.id, operation.capsuleId), eq(capsulesTable.ownerId, operation.ownerId)))
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
    const now = new Date()
    const [claimed] = await this.db
      .update(capsuleOperationsTable)
      .set({
        status: CapsuleOperationStatus.RUNNING,
        executionStartedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleOperationsTable.id, operationId),
          eq(capsuleOperationsTable.type, CapsuleOperationType.DESTROY),
          eq(capsuleOperationsTable.status, CapsuleOperationStatus.ACCEPTED),
          isNull(capsuleOperationsTable.providerMutationStartedAt),
        ),
      )
      .returning({
        ownerId: capsuleOperationsTable.ownerId,
        capsuleId: capsuleOperationsTable.capsuleId,
        status: capsuleOperationsTable.status,
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
          eq(capsuleOperationsTable.type, CapsuleOperationType.DESTROY),
          eq(capsuleOperationsTable.status, CapsuleOperationStatus.RUNNING),
          isNull(capsuleOperationsTable.providerMutationStartedAt),
        ),
      )
      .returning({
        id: capsuleOperationsTable.id,
      })
    if (updated.length !== 1) {
      throw new IncusError('Failed to commit the capsule destroy provider-intent fence.', 'CONFLICT', {
        operationId,
      })
    }
  }

  private async loadAcceptedBranches(ownerId: string, capsuleId: string): Promise<DestroyCapsuleAcceptedBranch[]> {
    return await this.db
      .select({
        id: capsuleBranchesTable.id,
        capsuleId: capsuleBranchesTable.capsuleId,
        ownerId: capsuleBranchesTable.ownerId,
        name: capsuleBranchesTable.name,
        status: capsuleBranchesTable.status,
        isRootBranch: capsuleBranchesTable.isRootBranch,
        resourceInventoryDigest: capsuleBranchesTable.resourceInventoryDigest,
      })
      .from(capsuleBranchesTable)
      .where(and(eq(capsuleBranchesTable.ownerId, ownerId), eq(capsuleBranchesTable.capsuleId, capsuleId)))
      .orderBy(asc(capsuleBranchesTable.id))
  }
}
