import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm'
import {
  CapsuleBranchCommandName,
  TargetType,
  type CapsuleBlueprintDigest,
  type CapsuleBranchStatus,
  type CapsuleChannel,
  type CapsuleCommandAck,
} from '@qiln/core/server'
import type { EnginePersistence } from '../../persistence'

const OPERATIONAL_CAPSULE_LIFECYCLE_STATUSES = ['provisioning', 'active'] as const

/**
 * Server-side branch projection returned by the Engine service boundary.
 *
 * The client-facing `CapsuleBranchSummary` type remains inferred from the tRPC
 * router in `types.ts`. Keeping the service projection explicitly named avoids
 * ambiguous package exports while preserving a clear server/client boundary.
 */
export interface CapsuleBranchesServiceSummary {
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
}

type CapsuleBranchRow = {
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
}

/**
 * Public Engine boundary for existing capsule branch runtimes.
 *
 * Creating a capsule belongs to `CapsuleOperationsService`, while future
 * snapshot-based branch forks will use a separate durable operation. This
 * service owns only operational branch reads and start/stop delegation.
 */
export class CapsuleBranchesService {
  constructor(
    private readonly persistence: EnginePersistence,
    private readonly channel: CapsuleChannel,
  ) {}

  /**
   * Lists branches belonging to unarchived provisioning or active capsules.
   *
   * Provisioning branches remain visible after durable create acceptance so the
   * UI can display progress. Worker-side aggregate locks still prevent runtime
   * start and stop until the capsule is active.
   *
   * Failed, cleanup-required, archiving, unarchiving, destroying, and destroyed
   * capsule aggregates are excluded from this operational branch surface.
   */
  public async list(ownerId: string): Promise<CapsuleBranchesServiceSummary[]> {
    const { db, tables } = this.persistence
    const branches = tables.capsuleBranches
    const capsules = tables.capsules
    const rows = await db
      .select({
        id: branches.id,
        capsuleId: branches.capsuleId,
        name: branches.name,
        status: branches.status,
        isRootBranch: branches.isRootBranch,
        cpu: branches.cpu,
        memory: branches.memory,
        blueprintName: branches.blueprintName,
        blueprintDigest: branches.blueprintDigest,
        runtimeIp: branches.runtimeIp,
        createdAt: branches.createdAt,
        updatedAt: branches.updatedAt,
      })
      .from(branches)
      .innerJoin(capsules, eq(capsules.id, branches.capsuleId))
      .where(
        and(
          eq(branches.ownerId, ownerId),
          eq(capsules.ownerId, ownerId),
          inArray(capsules.lifecycleStatus, OPERATIONAL_CAPSULE_LIFECYCLE_STATUSES),
          isNull(capsules.archivedAt),
          ne(branches.status, 'destroyed'),
        ),
      )
      .orderBy(desc(branches.createdAt))
    return rows.map(row => this.mapBranchRow(row))
  }

  /**
   * Resolves one operational branch by its complete owner-scoped capsule
   * identity.
   *
   * The lifecycle policy is intentionally identical to `list()`.
   */
  public async state(ownerId: string, capsuleId: string, name: string): Promise<CapsuleBranchesServiceSummary | null> {
    const { db, tables } = this.persistence
    const branches = tables.capsuleBranches
    const capsules = tables.capsules
    const [row] = await db
      .select({
        id: branches.id,
        capsuleId: branches.capsuleId,
        name: branches.name,
        status: branches.status,
        isRootBranch: branches.isRootBranch,
        cpu: branches.cpu,
        memory: branches.memory,
        blueprintName: branches.blueprintName,
        blueprintDigest: branches.blueprintDigest,
        runtimeIp: branches.runtimeIp,
        createdAt: branches.createdAt,
        updatedAt: branches.updatedAt,
      })
      .from(branches)
      .innerJoin(capsules, eq(capsules.id, branches.capsuleId))
      .where(
        and(
          eq(branches.ownerId, ownerId),
          eq(branches.capsuleId, capsuleId),
          eq(branches.name, name),
          eq(capsules.ownerId, ownerId),
          inArray(capsules.lifecycleStatus, OPERATIONAL_CAPSULE_LIFECYCLE_STATUSES),
          isNull(capsules.archivedAt),
          ne(branches.status, 'destroyed'),
        ),
      )
      .limit(1)
    return row ? this.mapBranchRow(row) : null
  }

  public async start(ownerId: string, capsuleId: string, name: string): Promise<CapsuleCommandAck> {
    return await this.channel.command(CapsuleBranchCommandName.BRANCH_START, {
      target: {
        type: TargetType.OWNER,
        id: ownerId,
      },
      capsuleId,
      name,
    })
  }

  public async stop(ownerId: string, capsuleId: string, name: string): Promise<CapsuleCommandAck> {
    return await this.channel.command(CapsuleBranchCommandName.BRANCH_STOP, {
      target: {
        type: TargetType.OWNER,
        id: ownerId,
      },
      capsuleId,
      name,
    })
  }

  private mapBranchRow(row: CapsuleBranchRow): CapsuleBranchesServiceSummary {
    return {
      id: row.id,
      capsuleId: row.capsuleId,
      name: row.name,
      status: row.status,
      isRootBranch: row.isRootBranch,
      cpu: row.cpu,
      memory: row.memory,
      blueprintName: row.blueprintName,
      blueprintDigest: row.blueprintDigest,
      runtimeIp: row.runtimeIp,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }
}
