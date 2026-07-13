import { and, desc, eq, isNull, ne } from 'drizzle-orm'
import {
  CapsuleBranchCommandName,
  TargetType,
  capsuleBranchesTable,
  capsulesTable,
  type CapsuleBlueprintDigest,
  type CapsuleBranchStatus,
  type CapsuleChannel,
  type CapsuleCommandAck,
  type CapsuleHostDbContract,
  type TargetOwner,
} from '@qiln/core/server'

export interface CapsuleBranchRuntimeItem {
  id: string
  capsuleId: string
  name: string
  status: CapsuleBranchStatus
  isRootBranch: boolean
  cpu: string
  memory: string
  blueprint: string
  blueprintDigest: CapsuleBlueprintDigest
  ip: string | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Public Engine boundary for existing capsule branch runtimes.
 *
 * Creating a capsule belongs to `CapsuleLifecycleService`, while future
 * snapshot-based branch forks will use a separate operation. This service owns
 * only runtime reads and start/stop delegation for existing branches.
 */
export class CapsuleBranchRuntimeService {
  constructor(
    private readonly db: CapsuleHostDbContract,
    private readonly channel: CapsuleChannel,
  ) {}

  /**
   * Lists operational branches belonging to active, unarchived capsule aggregates. Destroyed branch rows
   * remain durable audit history and are intentionally excluded from the normal runtime surface.
   */
  public async list(ownerId: string): Promise<CapsuleBranchRuntimeItem[]> {
    const rows = await this.db
      .select({
        id: capsuleBranchesTable.id,
        capsuleId: capsuleBranchesTable.capsuleId,
        name: capsuleBranchesTable.name,
        status: capsuleBranchesTable.status,
        isRootBranch: capsuleBranchesTable.isRootBranch,
        cpu: capsuleBranchesTable.cpu,
        memory: capsuleBranchesTable.memory,
        blueprintName: capsuleBranchesTable.blueprintName,
        blueprintDigest: capsuleBranchesTable.blueprintDigest,
        runtimeIp: capsuleBranchesTable.runtimeIp,
        createdAt: capsuleBranchesTable.createdAt,
        updatedAt: capsuleBranchesTable.updatedAt,
      })
      .from(capsuleBranchesTable)
      .innerJoin(capsulesTable, eq(capsulesTable.id, capsuleBranchesTable.capsuleId))
      .where(
        and(
          eq(capsuleBranchesTable.ownerId, ownerId),
          eq(capsulesTable.ownerId, ownerId),
          isNull(capsulesTable.archivedAt),
          ne(capsuleBranchesTable.status, 'destroyed'),
        ),
      )
      .orderBy(desc(capsuleBranchesTable.createdAt))
    return rows.map(row => this.mapBranchRow(row))
  }

  /**
   * Resolves one operational branch by its complete owner-scoped capsule identity.
   */
  public async state(ownerId: string, capsuleId: string, name: string): Promise<CapsuleBranchRuntimeItem | null> {
    const [row] = await this.db
      .select({
        id: capsuleBranchesTable.id,
        capsuleId: capsuleBranchesTable.capsuleId,
        name: capsuleBranchesTable.name,
        status: capsuleBranchesTable.status,
        isRootBranch: capsuleBranchesTable.isRootBranch,
        cpu: capsuleBranchesTable.cpu,
        memory: capsuleBranchesTable.memory,
        blueprintName: capsuleBranchesTable.blueprintName,
        blueprintDigest: capsuleBranchesTable.blueprintDigest,
        runtimeIp: capsuleBranchesTable.runtimeIp,
        createdAt: capsuleBranchesTable.createdAt,
        updatedAt: capsuleBranchesTable.updatedAt,
      })
      .from(capsuleBranchesTable)
      .innerJoin(capsulesTable, eq(capsulesTable.id, capsuleBranchesTable.capsuleId))
      .where(
        and(
          eq(capsuleBranchesTable.ownerId, ownerId),
          eq(capsuleBranchesTable.capsuleId, capsuleId),
          eq(capsuleBranchesTable.name, name),
          eq(capsulesTable.ownerId, ownerId),
          isNull(capsulesTable.archivedAt),
          ne(capsuleBranchesTable.status, 'destroyed'),
        ),
      )
      .limit(1)
    return row ? this.mapBranchRow(row) : null
  }

  public async start(ownerId: string, capsuleId: string, name: string): Promise<CapsuleCommandAck> {
    return await this.channel.command(CapsuleBranchCommandName.BRANCH_START, {
      target: this.ownerTarget(ownerId),
      capsuleId,
      name,
    })
  }

  public async stop(ownerId: string, capsuleId: string, name: string): Promise<CapsuleCommandAck> {
    return await this.channel.command(CapsuleBranchCommandName.BRANCH_STOP, {
      target: this.ownerTarget(ownerId),
      capsuleId,
      name,
    })
  }

  private ownerTarget(ownerId: string): TargetOwner {
    return {
      type: TargetType.OWNER,
      id: ownerId,
    }
  }

  private mapBranchRow(row: {
    id: string
    capsuleId: string
    name: string
    status: CapsuleBranchStatus
    isRootBranch: boolean
    cpu: string
    memory: string
    blueprintName: string
    blueprintDigest: CapsuleBlueprintDigest
    runtimeIp: string | null
    createdAt: Date
    updatedAt: Date
  }): CapsuleBranchRuntimeItem {
    return {
      id: row.id,
      capsuleId: row.capsuleId,
      name: row.name,
      status: row.status,
      isRootBranch: row.isRootBranch,
      cpu: row.cpu,
      memory: row.memory,
      blueprint: row.blueprintName,
      blueprintDigest: row.blueprintDigest,
      ip: row.runtimeIp,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }
}
