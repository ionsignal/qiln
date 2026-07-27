import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { CapsulePersistence, CapsuleTables } from '@qiln/core/server'
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
  'capturing',
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
   * Lists branch runtimes that are safe to observe during Worker startup.
   *
   * Capture-fenced, cleanup-required, archived, destroying, destroyed,
   * provisioning, and failed-creation aggregates are intentionally excluded.
   */
  public async listRuntimeReconciliationCandidates(): Promise<BranchRuntimeReconciliationCandidate[]> {
    const db = this.persistence.db
    const { capsules, capsuleBranches } = this.persistence.tables
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
        ),
      )
      .orderBy(asc(capsuleBranches.ownerId), asc(capsuleBranches.id))
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

  public async recordConfirmedRuntimeState(
    input: ConfirmedBranchRuntimeStateInput,
  ): Promise<ConfirmedBranchRuntimeStateResult> {
    const db = this.persistence.db
    const branches = this.persistence.tables.capsuleBranches
    return await db.transaction(async tx => {
      await this.lockActiveCapsule(tx, input.ownerId, input.capsuleId)
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

  private async beginBranchRuntimeTransition(
    ownerId: string,
    capsuleId: string,
    branchName: string,
    requiredStatus: 'offline' | 'online',
    transitionalStatus: 'starting' | 'stopping',
  ): Promise<BranchRuntimeTransitionContext> {
    const db = this.persistence.db
    const branches = this.persistence.tables.capsuleBranches
    return await db.transaction(async tx => {
      await this.lockActiveCapsule(tx, ownerId, capsuleId)
      const [branch] = await tx
        .select({
          id: branches.id,
          capsuleId: branches.capsuleId,
          name: branches.name,
          status: branches.status,
        })
        .from(branches)
        .where(and(eq(branches.ownerId, ownerId), eq(branches.capsuleId, capsuleId), eq(branches.name, branchName)))
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
        .update(branches)
        .set({
          status: transitionalStatus,
          runtimeIp: transitionalStatus === 'stopping' ? null : undefined,
          runtimeErrorCode: null,
          runtimeErrorMessage: null,
          runtimeErrorDetails: null,
          runtimeErrorAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(branches.id, branch.id), eq(branches.status, requiredStatus)))
        .returning({
          id: branches.id,
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
      throw new IncusError('Archived or non-active capsules cannot change branch runtime state.', 'CONFLICT', {
        capsuleId,
        lifecycleStatus: capsule.lifecycleStatus,
        archived: capsule.archivedAt !== null,
      })
    }
  }
}
