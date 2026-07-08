import { and, eq, inArray } from 'drizzle-orm'
import { capsuleBranchesTable, type CapsuleBranchStatus, type CapsuleHostDbContract } from '@qiln/core/server'
import type { ReconcileBranch } from './types'

/**
 * Persistence boundary for the capsule branch read model.
 *
 * Branch runtime state is separate from operation progress: a branch can be created, started,
 * stopped, deleted, recovered, or later snapshot-promoted by multiple durable operations over time.
 */
export class CapsuleBranchStore {
  constructor(private readonly db: CapsuleHostDbContract) {}

  public async listBranches(ownerId: string) {
    return await this.db.query.capsuleBranches.findMany({
      where: { ownerId },
      orderBy: (capsuleBranches, { desc }) => [desc(capsuleBranches.createdAt)],
    })
  }

  public async findBranch(ownerId: string, name: string) {
    return await this.db.query.capsuleBranches.findFirst({
      where: { name, ownerId },
    })
  }

  public async listBranchesForReconcile(): Promise<ReconcileBranch[]> {
    const rows = await this.db.query.capsuleBranches.findMany({
      columns: { name: true, ownerId: true, status: true },
    })
    return rows
  }

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
      .where(and(eq(capsuleBranchesTable.ownerId, ownerId), eq(capsuleBranchesTable.name, name)))
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
      .returning({ id: capsuleBranchesTable.id })
    return result.length > 0
  }

  public async deleteBranch(ownerId: string, name: string): Promise<void> {
    await this.db.delete(capsuleBranchesTable).where(and(eq(capsuleBranchesTable.ownerId, ownerId), eq(capsuleBranchesTable.name, name)))
  }
}
