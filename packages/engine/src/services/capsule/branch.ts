import { and, desc, eq, ne } from 'drizzle-orm'
import {
  CapsuleBranchCommandName,
  DEFAULT_CAPSULE_BLUEPRINT_NAME,
  TargetType,
  capsuleBranchesTable,
  type CapsuleBlueprintDigest,
  type CapsuleBranchCreateOutput,
  type CapsuleBranchDeleteOutput,
  type CapsuleBranchStatus,
  type CapsuleChannel,
  type CapsuleCommandAck,
  type TargetOwner,
} from '@qiln/core/server'
import type { CapsuleHostDbContract } from '@qiln/core/server'

export interface CapsuleBranchServiceItem {
  id: string
  name: string
  status: CapsuleBranchStatus
  cpu: string
  memory: string
  blueprint: string
  blueprintDigest: CapsuleBlueprintDigest
  ip: string | null
  createdAt: Date
  updatedAt: Date
}

export interface CapsuleBranchCreateRequest {
  idempotencyKey: string
  name: string
  blueprintName?: string
  blueprintDigest: CapsuleBlueprintDigest
  cpu?: string
  memory?: string
}

interface CapsuleBranchRow {
  id: string
  name: string
  status: CapsuleBranchStatus
  cpu: string
  memory: string
  blueprintName: string
  blueprintDigest: CapsuleBlueprintDigest
  runtimeIp: string | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Public-engine capsule branch service.
 *
 * Branch mutations are operation-oriented: callers provide idempotency keys and the worker
 * returns durable operation receipts for retry-safe mutation requests.
 */
export class CapsuleBranchService {
  constructor(
    private readonly db: CapsuleHostDbContract,
    private readonly channel: CapsuleChannel,
  ) {}

  /**
   * Lists active capsule branch runtimes.
   *
   * Archived branches are durable history and intentionally stay outside the normal operational list.
   * A future history surface must use an explicit branch-history query rather than weakening this runtime query.
   */
  public async list(ownerId: string): Promise<CapsuleBranchServiceItem[]> {
    const rows = await this.db
      .select()
      .from(capsuleBranchesTable)
      .where(and(eq(capsuleBranchesTable.ownerId, ownerId), ne(capsuleBranchesTable.status, 'archived')))
      .orderBy(desc(capsuleBranchesTable.createdAt))
    return rows.map(row => this.mapBranchRow(row))
  }

  /**
   * Resolves an active capsule branch runtime by name.
   *
   * An archived branch may share a name with a later active branch, so branch runtime reads must exclude archived historical records.
   */
  public async state(ownerId: string, name: string): Promise<CapsuleBranchServiceItem | null> {
    const [row] = await this.db
      .select()
      .from(capsuleBranchesTable)
      .where(and(eq(capsuleBranchesTable.ownerId, ownerId), eq(capsuleBranchesTable.name, name), ne(capsuleBranchesTable.status, 'archived')))
      .limit(1)
    return row ? this.mapBranchRow(row) : null
  }

  public async create(ownerId: string, input: CapsuleBranchCreateRequest): Promise<CapsuleBranchCreateOutput> {
    return await this.channel.command(CapsuleBranchCommandName.BRANCH_CREATE, {
      name: input.name,
      target: this.ownerTarget(ownerId),
      idempotencyKey: input.idempotencyKey,
      blueprintName: input.blueprintName ?? DEFAULT_CAPSULE_BLUEPRINT_NAME,
      blueprintDigest: input.blueprintDigest,
      cpu: input.cpu ?? '4',
      memory: input.memory ?? '4GB',
    })
  }

  public async start(ownerId: string, name: string): Promise<CapsuleCommandAck> {
    return await this.channel.command(CapsuleBranchCommandName.BRANCH_START, {
      target: this.ownerTarget(ownerId),
      name,
    })
  }

  public async stop(ownerId: string, name: string): Promise<CapsuleCommandAck> {
    return await this.channel.command(CapsuleBranchCommandName.BRANCH_STOP, {
      target: this.ownerTarget(ownerId),
      name,
    })
  }

  public async delete(ownerId: string, name: string, idempotencyKey: string): Promise<CapsuleBranchDeleteOutput> {
    return await this.channel.command(CapsuleBranchCommandName.BRANCH_DELETE, {
      target: this.ownerTarget(ownerId),
      name,
      idempotencyKey,
    })
  }

  private ownerTarget(ownerId: string): TargetOwner {
    return {
      type: TargetType.OWNER,
      id: ownerId,
    }
  }

  private mapBranchRow(row: CapsuleBranchRow): CapsuleBranchServiceItem {
    return {
      id: row.id,
      name: row.name,
      status: row.status,
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
