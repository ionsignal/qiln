import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import { capsuleBranchesTable, capsulesTable, type CapsuleHostDbContract } from '@qiln/core/server'
import { IncusError } from '../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from '../failures'
import { toJsonObject } from '../persistence/json'
import type {
  BranchRuntimeErrorInput,
  BranchRuntimeErrorResult,
  BranchRuntimeReconciliationCandidate,
  BranchRuntimeTransitionContext,
  ConfirmedBranchRuntimeStateInput,
  ConfirmedBranchRuntimeStateResult,
} from './types'

const ACTIVE_BRANCH_STATUSES = [
  'provisioning',
  'offline',
  'starting',
  'online',
  'stopping',
  'destroying',
  'error',
  'cleanup_required',
] as const
const RUNTIME_RECONCILIATION_STATUSES = ['offline', 'starting', 'online', 'stopping', 'error'] as const

/**
 * Persistence boundary for capsule branch runtime state.
 *
 * Capsule lifecycle is authoritative over branch runtime mutations.
 * Transitional branch states are durable mutation fences, and every state write
 * revalidates the active, unarchived capsule aggregate.
 */
export class CapsuleBranchStore {
  constructor(private readonly db: CapsuleHostDbContract) {}

  public async listBranches(ownerId: string) {
    return await this.db
      .select()
      .from(capsuleBranchesTable)
      .where(
        and(eq(capsuleBranchesTable.ownerId, ownerId), inArray(capsuleBranchesTable.status, ACTIVE_BRANCH_STATUSES)),
      )
      .orderBy(desc(capsuleBranchesTable.createdAt))
  }

  public async listBranchesForCapsule(ownerId: string, capsuleId: string) {
    return await this.db
      .select()
      .from(capsuleBranchesTable)
      .where(and(eq(capsuleBranchesTable.ownerId, ownerId), eq(capsuleBranchesTable.capsuleId, capsuleId)))
      .orderBy(asc(capsuleBranchesTable.id))
  }

  public async findBranch(ownerId: string, capsuleId: string, name: string) {
    const [branch] = await this.db
      .select()
      .from(capsuleBranchesTable)
      .where(
        and(
          eq(capsuleBranchesTable.ownerId, ownerId),
          eq(capsuleBranchesTable.capsuleId, capsuleId),
          eq(capsuleBranchesTable.name, name),
          inArray(capsuleBranchesTable.status, ACTIVE_BRANCH_STATUSES),
        ),
      )
      .limit(1)
    return branch ?? null
  }

  public async findActiveBranchById(ownerId: string, branchId: string) {
    const [branch] = await this.db
      .select()
      .from(capsuleBranchesTable)
      .where(
        and(
          eq(capsuleBranchesTable.id, branchId),
          eq(capsuleBranchesTable.ownerId, ownerId),
          inArray(capsuleBranchesTable.status, ACTIVE_BRANCH_STATUSES),
        ),
      )
      .limit(1)
    return branch ?? null
  }

  public async findRootBranch(ownerId: string, capsuleId: string) {
    const branches = await this.db
      .select()
      .from(capsuleBranchesTable)
      .where(
        and(
          eq(capsuleBranchesTable.ownerId, ownerId),
          eq(capsuleBranchesTable.capsuleId, capsuleId),
          eq(capsuleBranchesTable.isRootBranch, true),
        ),
      )
      .limit(2)
    if (branches.length > 1) {
      throw new IncusError('Capsule has multiple durable root branches.', 'CONFLICT', {
        ownerId,
        capsuleId,
      })
    }
    return branches[0] ?? null
  }

  /**
   * Lists branch runtimes that are safe to observe during Worker startup.
   *
   * Cleanup-required, archived, destroying, destroyed, provisioning, and failed
   * creation aggregates are intentionally excluded.
   */
  public async listRuntimeReconciliationCandidates(): Promise<BranchRuntimeReconciliationCandidate[]> {
    return await this.db
      .select({
        id: capsuleBranchesTable.id,
        capsuleId: capsuleBranchesTable.capsuleId,
        ownerId: capsuleBranchesTable.ownerId,
        name: capsuleBranchesTable.name,
        status: capsuleBranchesTable.status,
      })
      .from(capsuleBranchesTable)
      .innerJoin(capsulesTable, eq(capsulesTable.id, capsuleBranchesTable.capsuleId))
      .where(
        and(
          eq(capsulesTable.lifecycleStatus, 'active'),
          isNull(capsulesTable.archivedAt),
          inArray(capsuleBranchesTable.status, RUNTIME_RECONCILIATION_STATUSES),
        ),
      )
      .orderBy(asc(capsuleBranchesTable.ownerId), asc(capsuleBranchesTable.id))
  }

  public async beginBranchStart(
    ownerId: string,
    capsuleId: string,
    branchName: string,
  ): Promise<BranchRuntimeTransitionContext> {
    return await this.beginBranchRuntimeTransition(ownerId, capsuleId, branchName, 'offline', 'starting')
  }

  public async beginBranchStop(
    ownerId: string,
    capsuleId: string,
    branchName: string,
  ): Promise<BranchRuntimeTransitionContext> {
    return await this.beginBranchRuntimeTransition(ownerId, capsuleId, branchName, 'online', 'stopping')
  }

  /**
   * Persists one provider-confirmed stable branch state.
   *
   * The operation is idempotent when the confirmed state was committed but the
   * caller did not receive the database result. A different current state still
   * fails closed as a concurrent lifecycle conflict.
   */
  public async recordConfirmedRuntimeState(
    input: ConfirmedBranchRuntimeStateInput,
  ): Promise<ConfirmedBranchRuntimeStateResult> {
    return await this.db.transaction(async tx => {
      await this.lockActiveCapsule(tx, input.ownerId, input.capsuleId)
      const [branch] = await tx
        .select({
          id: capsuleBranchesTable.id,
          name: capsuleBranchesTable.name,
          status: capsuleBranchesTable.status,
        })
        .from(capsuleBranchesTable)
        .where(
          and(
            eq(capsuleBranchesTable.id, input.branchId),
            eq(capsuleBranchesTable.ownerId, input.ownerId),
            eq(capsuleBranchesTable.capsuleId, input.capsuleId),
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
        .update(capsuleBranchesTable)
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
            eq(capsuleBranchesTable.id, input.branchId),
            eq(capsuleBranchesTable.ownerId, input.ownerId),
            eq(capsuleBranchesTable.capsuleId, input.capsuleId),
            eq(capsuleBranchesTable.status, branch.status),
          ),
        )
        .returning({
          name: capsuleBranchesTable.name,
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

  /**
   * Marks a branch runtime as uncertain after Qiln could not prove a stable
   * provider state.
   */
  public async recordRuntimeError(input: BranchRuntimeErrorInput): Promise<BranchRuntimeErrorResult> {
    const failureDetails = createFailureDetails(input.error, input.context) ?? {
      context: input.context,
    }
    return await this.db.transaction(async tx => {
      await this.lockActiveCapsule(tx, input.ownerId, input.capsuleId)
      const [branch] = await tx
        .select({
          id: capsuleBranchesTable.id,
          name: capsuleBranchesTable.name,
          status: capsuleBranchesTable.status,
        })
        .from(capsuleBranchesTable)
        .where(
          and(
            eq(capsuleBranchesTable.id, input.branchId),
            eq(capsuleBranchesTable.ownerId, input.ownerId),
            eq(capsuleBranchesTable.capsuleId, input.capsuleId),
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
        .update(capsuleBranchesTable)
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
            eq(capsuleBranchesTable.id, input.branchId),
            eq(capsuleBranchesTable.ownerId, input.ownerId),
            eq(capsuleBranchesTable.capsuleId, input.capsuleId),
            eq(capsuleBranchesTable.status, branch.status),
          ),
        )
        .returning({
          name: capsuleBranchesTable.name,
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

  private async beginBranchRuntimeTransition(
    ownerId: string,
    capsuleId: string,
    branchName: string,
    requiredStatus: 'offline' | 'online',
    transitionalStatus: 'starting' | 'stopping',
  ): Promise<BranchRuntimeTransitionContext> {
    return await this.db.transaction(async tx => {
      await this.lockActiveCapsule(tx, ownerId, capsuleId)
      const [branch] = await tx
        .select({
          id: capsuleBranchesTable.id,
          capsuleId: capsuleBranchesTable.capsuleId,
          name: capsuleBranchesTable.name,
          status: capsuleBranchesTable.status,
        })
        .from(capsuleBranchesTable)
        .where(
          and(
            eq(capsuleBranchesTable.ownerId, ownerId),
            eq(capsuleBranchesTable.capsuleId, capsuleId),
            eq(capsuleBranchesTable.name, branchName),
          ),
        )
        .for('update')
        .limit(1)
      if (!branch) {
        throw new IncusError('Capsule branch not found or access denied.', 'NOT_FOUND', {
          capsuleId,
          branchName,
        })
      }
      if (branch.status !== requiredStatus) {
        throw new IncusError(
          `Capsule branch cannot enter '${transitionalStatus}' from '${branch.status}'.`,
          'CONFLICT',
          {
            capsuleId,
            branchId: branch.id,
            branchName,
            currentStatus: branch.status,
            requiredStatus,
          },
        )
      }
      const [transitioned] = await tx
        .update(capsuleBranchesTable)
        .set({
          status: transitionalStatus,
          runtimeIp: transitionalStatus === 'stopping' ? null : undefined,
          runtimeErrorCode: null,
          runtimeErrorMessage: null,
          runtimeErrorDetails: null,
          runtimeErrorAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(capsuleBranchesTable.id, branch.id), eq(capsuleBranchesTable.status, requiredStatus)))
        .returning({
          id: capsuleBranchesTable.id,
        })
      if (!transitioned) {
        throw new IncusError(
          'Capsule branch runtime transition conflicted with another lifecycle change.',
          'CONFLICT',
          {
            capsuleId,
            branchId: branch.id,
            branchName,
            requiredStatus,
            transitionalStatus,
          },
        )
      }
      return {
        ownerId,
        branchId: branch.id,
        capsuleId: branch.capsuleId,
        branchName: branch.name,
        previousStatus: requiredStatus,
        transitionalStatus,
      }
    })
  }

  private async lockActiveCapsule(
    tx: Parameters<Parameters<CapsuleHostDbContract['transaction']>[0]>[0],
    ownerId: string,
    capsuleId: string,
  ): Promise<void> {
    const [capsule] = await tx
      .select({
        id: capsulesTable.id,
        lifecycleStatus: capsulesTable.lifecycleStatus,
        archivedAt: capsulesTable.archivedAt,
      })
      .from(capsulesTable)
      .where(and(eq(capsulesTable.id, capsuleId), eq(capsulesTable.ownerId, ownerId)))
      .for('update')
      .limit(1)
    if (!capsule) {
      throw new IncusError('Capsule not found or access denied.', 'NOT_FOUND', {
        capsuleId,
      })
    }
    if (capsule.lifecycleStatus !== 'active' || capsule.archivedAt !== null) {
      throw new IncusError('Archived or non-active capsules cannot change branch runtime state.', 'CONFLICT', {
        capsuleId,
        lifecycleStatus: capsule.lifecycleStatus,
        archived: capsule.archivedAt !== null,
      })
    }
  }
}
