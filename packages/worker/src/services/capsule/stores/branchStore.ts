import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm'
import {
  capsuleBranchesTable,
  type CapsuleBranchResourceInventoryDigest,
  type CapsuleBranchStatus,
  type CapsuleHostDbContract,
} from '@qiln/core/server'
import { IncusError } from '../../../errors'
import type { ReconcileBranch } from './types'

/**
 * Persistence boundary for the capsule branch read model.
 *
 * Branch runtime state is separate from operation progress: a branch can be created, started, stopped,
 * retired, recovered, or later snapshot-promoted by multiple durable operations over time.
 */
export class CapsuleBranchStore {
  constructor(private readonly db: CapsuleHostDbContract) {}

  /**
   * Lists active branch runtimes for an owner.
   *
   * Archived branch rows remain durable history and must be read through an
   * explicit history-oriented query when that product surface is introduced.
   */
  public async listBranches(ownerId: string) {
    return await this.db
      .select()
      .from(capsuleBranchesTable)
      .where(and(eq(capsuleBranchesTable.ownerId, ownerId), ne(capsuleBranchesTable.status, 'archived')))
      .orderBy(desc(capsuleBranchesTable.createdAt))
  }

  /**
   * Resolves an active branch runtime by its user-facing name.
   *
   * The partial unique index permits an archived branch and an active branch to
   * share a name, so operational reads must always exclude archived history.
   */
  public async findBranch(ownerId: string, name: string) {
    const [branch] = await this.db
      .select()
      .from(capsuleBranchesTable)
      .where(and(eq(capsuleBranchesTable.ownerId, ownerId), eq(capsuleBranchesTable.name, name), ne(capsuleBranchesTable.status, 'archived')))
      .limit(1)

    return branch ?? null
  }

  /**
   * Lists active branches eligible for runtime reconciliation.
   *
   * Archived branches intentionally have no runtime and must never be inspected
   * or rewritten by reconciliation.
   */
  public async listBranchesForReconcile(): Promise<ReconcileBranch[]> {
    return await this.db
      .select({
        name: capsuleBranchesTable.name,
        ownerId: capsuleBranchesTable.ownerId,
        status: capsuleBranchesTable.status,
      })
      .from(capsuleBranchesTable)
      .where(ne(capsuleBranchesTable.status, 'archived'))
  }

  /**
   * Persists the complete planned resource identity before branch provisioning contacts Incus. Existing
   * non-null values are never overwritten because an inline operation is not resumable after interruption.
   */
  public async recordBranchResourceInventoryDigest(
    ownerId: string,
    name: string,
    resourceInventoryDigest: CapsuleBranchResourceInventoryDigest,
  ): Promise<void> {
    const updatedBranches = await this.db
      .update(capsuleBranchesTable)
      .set({
        resourceInventoryDigest,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(capsuleBranchesTable.ownerId, ownerId),
          eq(capsuleBranchesTable.name, name),
          eq(capsuleBranchesTable.status, 'provisioning'),
          isNull(capsuleBranchesTable.resourceInventoryDigest),
        ),
      )
      .returning({
        id: capsuleBranchesTable.id,
      })
    if (updatedBranches.length !== 1) {
      throw new IncusError('Failed to persist the capsule branch resource inventory proof.', 'API_ERROR', {
        ownerId,
        branchName: name,
      })
    }
  }

  /**
   * Transitions one active runtime branch by its owner/name identity.
   *
   * Archived rows intentionally remain immutable through operational mutation paths so historical
   * branch state cannot be mistaken for a live runtime.
   */
  public async transitionBranchState(ownerId: string, name: string, status: CapsuleBranchStatus, ip?: string | null): Promise<void> {
    const updateData: {
      status: CapsuleBranchStatus
      runtimeIp?: string | null
      updatedAt: Date
    } = {
      status,
      updatedAt: new Date(),
    }
    if (ip !== undefined) {
      updateData.runtimeIp = ip
    }
    await this.db
      .update(capsuleBranchesTable)
      .set(updateData)
      .where(and(eq(capsuleBranchesTable.ownerId, ownerId), eq(capsuleBranchesTable.name, name), ne(capsuleBranchesTable.status, 'archived')))
  }

  public async transitionBranchStateWhereStatus(
    ownerId: string,
    name: string,
    status: CapsuleBranchStatus,
    allowedStatuses: CapsuleBranchStatus[],
  ): Promise<boolean> {
    if (allowedStatuses.length === 0) {
      return false
    }
    const result = await this.db
      .update(capsuleBranchesTable)
      .set({
        status,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(capsuleBranchesTable.ownerId, ownerId),
          eq(capsuleBranchesTable.name, name),
          inArray(capsuleBranchesTable.status, allowedStatuses),
        ),
      )
      .returning({
        id: capsuleBranchesTable.id,
      })
    return result.length > 0
  }

  /**
   * Retires the active branch runtime after every provider-owned resource has a
   * durably recorded deletion outcome. The branch row stays intact as the
   * stable identity for operation, step, and resource history.
   */
  public async archiveBranchRuntime(ownerId: string, branchId: string): Promise<void> {
    const archivedBranches = await this.db
      .update(capsuleBranchesTable)
      .set({
        status: 'archived',
        runtimeIp: null,
        updatedAt: new Date(),
      })
      .where(and(eq(capsuleBranchesTable.id, branchId), eq(capsuleBranchesTable.ownerId, ownerId), eq(capsuleBranchesTable.status, 'deleting')))
      .returning({
        id: capsuleBranchesTable.id,
      })
    if (archivedBranches.length !== 1) {
      throw new IncusError('Failed to archive capsule branch runtime. Manual review is required.', 'CONFLICT', {
        ownerId,
        branchId,
      })
    }
  }

  /**
   * Create compensation uses this direct removal path because the branch never became an active runtime.
   * Destructive user-requested deletion must archive the durable branch record through `archiveBranchRuntime()`.
   */
  public async deleteBranch(ownerId: string, name: string): Promise<void> {
    await this.db
      .delete(capsuleBranchesTable)
      .where(and(eq(capsuleBranchesTable.ownerId, ownerId), eq(capsuleBranchesTable.name, name), ne(capsuleBranchesTable.status, 'archived')))
  }
}
