import { and, asc, desc, eq, inArray, isNull, notExists } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { CapsuleOperationStatus, type CapsulePersistence, type CapsuleTables } from '@qiln/core/server'
import { IncusError } from '../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from '../failures'
import { toJsonObject } from '../persistence/json'
import type {
  BranchRuntimeErrorInput,
  BranchRuntimeErrorResult,
  BranchRuntimeReconciliationCandidate,
  ConfirmedBranchRuntimeStateInput,
  ConfirmedBranchRuntimeStateResult,
} from './types'

const ACTIVE_BRANCH_STATUSES = [
  'provisioning',
  'offline',
  'snapshotting',
  'starting',
  'online',
  'stopping',
  'destroying',
  'error',
  'cleanup_required',
] as const

const RUNTIME_RECONCILIATION_STATUSES = ['offline', 'starting', 'online', 'stopping', 'error'] as const

const NONTERMINAL_OPERATION_STATUSES = [CapsuleOperationStatus.ACCEPTED, CapsuleOperationStatus.RUNNING] as const

/**
 * Read and reconciliation persistence for capsule branch runtime state.
 *
 * Start and stop transitions belong to their durable operation repositories.
 * Reconciliation writes are allowed only when no accepted or running capsule
 * operation owns the aggregate.
 */
export class CapsuleBranchStore<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly persistence: CapsulePersistence<TDatabase, TTables>) {}

  public async listBranches(ownerId: string) {
    const db = this.persistence.db
    const branches = this.persistence.tables.capsuleBranches
    return await db
      .select()
      .from(branches)
      .where(and(eq(branches.ownerId, ownerId), inArray(branches.status, ACTIVE_BRANCH_STATUSES)))
      .orderBy(desc(branches.createdAt))
  }

  public async listBranchesForCapsule(ownerId: string, capsuleId: string) {
    const db = this.persistence.db
    const branches = this.persistence.tables.capsuleBranches
    return await db
      .select()
      .from(branches)
      .where(and(eq(branches.ownerId, ownerId), eq(branches.capsuleId, capsuleId)))
      .orderBy(asc(branches.id))
  }

  public async findBranch(ownerId: string, capsuleId: string, name: string) {
    const db = this.persistence.db
    const branches = this.persistence.tables.capsuleBranches
    const [branch] = await db
      .select()
      .from(branches)
      .where(
        and(
          eq(branches.ownerId, ownerId),
          eq(branches.capsuleId, capsuleId),
          eq(branches.name, name),
          inArray(branches.status, ACTIVE_BRANCH_STATUSES),
        ),
      )
      .limit(1)
    return branch ?? null
  }

  public async findActiveBranchById(ownerId: string, branchId: string) {
    const db = this.persistence.db
    const branches = this.persistence.tables.capsuleBranches
    const [branch] = await db
      .select()
      .from(branches)
      .where(
        and(eq(branches.id, branchId), eq(branches.ownerId, ownerId), inArray(branches.status, ACTIVE_BRANCH_STATUSES)),
      )
      .limit(1)
    return branch ?? null
  }

  public async findRootBranch(ownerId: string, capsuleId: string) {
    const db = this.persistence.db
    const branches = this.persistence.tables.capsuleBranches
    const records = await db
      .select()
      .from(branches)
      .where(and(eq(branches.ownerId, ownerId), eq(branches.capsuleId, capsuleId), eq(branches.isRootBranch, true)))
      .limit(2)
    if (records.length > 1) {
      throw new IncusError('Capsule has multiple durable root branches.', 'CONFLICT', {
        ownerId,
        capsuleId,
      })
    }
    return records[0] ?? null
  }

  /**
   * Lists branch runtimes that are safe to observe during Worker
   * reconciliation.
   *
   * The query-level operation exclusion avoids unnecessary provider reads. Each
   * subsequent write repeats this fence after locking the capsule aggregate.
   */
  public async listRuntimeReconciliationCandidates(): Promise<BranchRuntimeReconciliationCandidate[]> {
    const db = this.persistence.db
    const { capsules, capsuleBranches, capsuleOperations } = this.persistence.tables
    return await db
      .select({
        id: capsuleBranches.id,
        capsuleId: capsuleBranches.capsuleId,
        ownerId: capsuleBranches.ownerId,
        name: capsuleBranches.name,
        status: capsuleBranches.status,
      })
      .from(capsuleBranches)
      .innerJoin(capsules, eq(capsules.id, capsuleBranches.capsuleId))
      .where(
        and(
          eq(capsules.lifecycleStatus, 'active'),
          isNull(capsules.archivedAt),
          inArray(capsuleBranches.status, RUNTIME_RECONCILIATION_STATUSES),
          notExists(
            db
              .select({
                id: capsuleOperations.id,
              })
              .from(capsuleOperations)
              .where(
                and(
                  eq(capsuleOperations.capsuleId, capsuleBranches.capsuleId),
                  inArray(capsuleOperations.status, NONTERMINAL_OPERATION_STATUSES),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(capsuleBranches.ownerId), asc(capsuleBranches.id))
  }

  public async recordConfirmedRuntimeState(
    input: ConfirmedBranchRuntimeStateInput,
  ): Promise<ConfirmedBranchRuntimeStateResult> {
    const db = this.persistence.db
    const branches = this.persistence.tables.capsuleBranches
    return await db.transaction(async tx => {
      await this.lockActiveCapsule(tx, input.ownerId, input.capsuleId)
      await this.assertReconciliationAvailable(tx, input.capsuleId)
      const [branch] = await tx
        .select({
          id: branches.id,
          name: branches.name,
          status: branches.status,
        })
        .from(branches)
        .where(
          and(
            eq(branches.id, input.branchId),
            eq(branches.ownerId, input.ownerId),
            eq(branches.capsuleId, input.capsuleId),
          ),
        )
        .for('update')
        .limit(1)
      if (!branch) {
        throw new IncusError('Capsule branch not found while recording confirmed runtime state.', 'NOT_FOUND', {
          ownerId: input.ownerId,
          capsuleId: input.capsuleId,
          branchId: input.branchId,
        })
      }
      if (branch.status !== input.expectedStatus && branch.status !== input.confirmedStatus) {
        throw new IncusError('Confirmed branch runtime state conflicted with another lifecycle change.', 'CONFLICT', {
          ownerId: input.ownerId,
          capsuleId: input.capsuleId,
          branchId: input.branchId,
          branchName: branch.name,
          expectedStatus: input.expectedStatus,
          confirmedStatus: input.confirmedStatus,
          actualStatus: branch.status,
        })
      }
      const statusChanged = branch.status !== input.confirmedStatus
      const runtimeIp = input.confirmedStatus === 'online' ? input.runtimeIp : null
      const [updated] = await tx
        .update(branches)
        .set({
          status: input.confirmedStatus,
          runtimeIp,
          runtimeErrorCode: null,
          runtimeErrorMessage: null,
          runtimeErrorDetails: null,
          runtimeErrorAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(branches.id, input.branchId),
            eq(branches.ownerId, input.ownerId),
            eq(branches.capsuleId, input.capsuleId),
            eq(branches.status, branch.status),
          ),
        )
        .returning({
          name: branches.name,
        })
      if (!updated) {
        throw new IncusError('Failed to persist provider-confirmed branch runtime state.', 'CONFLICT', {
          ownerId: input.ownerId,
          capsuleId: input.capsuleId,
          branchId: input.branchId,
          expectedStatus: input.expectedStatus,
          confirmedStatus: input.confirmedStatus,
        })
      }
      return {
        branchName: updated.name,
        previousStatus: branch.status,
        status: input.confirmedStatus,
        statusChanged,
      }
    })
  }

  public async recordRuntimeError(input: BranchRuntimeErrorInput): Promise<BranchRuntimeErrorResult> {
    const failureDetails = createFailureDetails(input.error, input.context) ?? {
      context: input.context,
    }
    const db = this.persistence.db
    const branches = this.persistence.tables.capsuleBranches
    return await db.transaction(async tx => {
      await this.lockActiveCapsule(tx, input.ownerId, input.capsuleId)
      await this.assertReconciliationAvailable(tx, input.capsuleId)
      const [branch] = await tx
        .select({
          id: branches.id,
          name: branches.name,
          status: branches.status,
        })
        .from(branches)
        .where(
          and(
            eq(branches.id, input.branchId),
            eq(branches.ownerId, input.ownerId),
            eq(branches.capsuleId, input.capsuleId),
          ),
        )
        .for('update')
        .limit(1)
      if (!branch) {
        throw new IncusError('Capsule branch not found while recording runtime uncertainty.', 'NOT_FOUND', {
          ownerId: input.ownerId,
          capsuleId: input.capsuleId,
          branchId: input.branchId,
        })
      }
      if (branch.status !== input.expectedStatus && branch.status !== 'error') {
        throw new IncusError('Branch runtime uncertainty conflicted with another lifecycle change.', 'CONFLICT', {
          ownerId: input.ownerId,
          capsuleId: input.capsuleId,
          branchId: input.branchId,
          branchName: branch.name,
          expectedStatus: input.expectedStatus,
          actualStatus: branch.status,
        })
      }
      const statusChanged = branch.status !== 'error'
      const [updated] = await tx
        .update(branches)
        .set({
          status: 'error',
          runtimeIp: null,
          runtimeErrorCode: failureCodeFromUnknown(input.error),
          runtimeErrorMessage: failureMessageFromUnknown(input.error, 'Capsule branch runtime state is uncertain.'),
          runtimeErrorDetails: toJsonObject(failureDetails, 'capsule branch runtime error details'),
          runtimeErrorAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(branches.id, input.branchId),
            eq(branches.ownerId, input.ownerId),
            eq(branches.capsuleId, input.capsuleId),
            eq(branches.status, branch.status),
          ),
        )
        .returning({
          name: branches.name,
        })
      if (!updated) {
        throw new IncusError('Failed to persist capsule branch runtime uncertainty.', 'CONFLICT', {
          ownerId: input.ownerId,
          capsuleId: input.capsuleId,
          branchId: input.branchId,
          expectedStatus: input.expectedStatus,
        })
      }
      return {
        branchName: updated.name,
        previousStatus: branch.status,
        status: 'error',
        statusChanged,
      }
    })
  }

  private async lockActiveCapsule(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    ownerId: string,
    capsuleId: string,
  ): Promise<void> {
    const capsules = this.persistence.tables.capsules
    const [capsule] = await tx
      .select({
        id: capsules.id,
        lifecycleStatus: capsules.lifecycleStatus,
        archivedAt: capsules.archivedAt,
      })
      .from(capsules)
      .where(and(eq(capsules.id, capsuleId), eq(capsules.ownerId, ownerId)))
      .for('update')
      .limit(1)
    if (!capsule) {
      throw new IncusError('Capsule not found or access denied.', 'NOT_FOUND', {
        capsuleId,
      })
    }
    if (capsule.lifecycleStatus !== 'active' || capsule.archivedAt !== null) {
      throw new IncusError('Archived or non-active capsules cannot reconcile branch runtime state.', 'CONFLICT', {
        capsuleId,
        lifecycleStatus: capsule.lifecycleStatus,
        archived: capsule.archivedAt !== null,
      })
    }
  }

  /**
   * Rechecks operation ownership after the capsule row is locked.
   *
   * Candidate filtering alone is insufficient because a start operation can own
   * an already-online branch while it finishes SSH coordination.
   */
  private async assertReconciliationAvailable(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    capsuleId: string,
  ): Promise<void> {
    const operations = this.persistence.tables.capsuleOperations
    const [operation] = await tx
      .select({
        id: operations.id,
        type: operations.type,
        status: operations.status,
      })
      .from(operations)
      .where(and(eq(operations.capsuleId, capsuleId), inArray(operations.status, NONTERMINAL_OPERATION_STATUSES)))
      .limit(1)
    if (!operation) {
      return
    }
    throw new IncusError('Branch runtime reconciliation is blocked by a nonterminal capsule operation.', 'CONFLICT', {
      capsuleId,
      operationId: operation.id,
      operationType: operation.type,
      operationStatus: operation.status,
    })
  }
}
