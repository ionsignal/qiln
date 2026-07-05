import {
  CapsuleBranchCommandName,
  DEFAULT_CAPSULE_BLUEPRINT_NAME,
  TargetType,
  type CapsuleBranchStatus,
  type CapsuleChannel,
  type CapsuleCommandAck,
  type TargetOwner,
} from '@qiln/core/server'
import type { CapsuleBranchHostDbContract } from '@qiln/core/server'

export interface CapsuleBranchServiceItem {
  id: string
  name: string
  status: CapsuleBranchStatus
  cpu: string
  memory: string
  blueprint: string
  ip: string | null
  createdAt: Date
  updatedAt: Date
}

export interface CapsuleBranchCreateRequest {
  name: string
  blueprint?: string
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
  runtimeIp: string | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Public-engine capsule branch service.
 *
 * The database now uses capsule branch terminology directly. The service keeps
 * the current API response shape stable so frontend and tRPC consumers continue
 * to receive `blueprint` and `ip` while the read model stores
 * `blueprint_name` and `runtime_ip`.
 */
export class CapsuleService {
  constructor(
    private readonly db: CapsuleBranchHostDbContract,
    private readonly channel: CapsuleChannel,
  ) {}

  public async list(ownerId: string): Promise<CapsuleBranchServiceItem[]> {
    const rows = await this.db.query.capsuleBranches.findMany({
      where: { ownerId },
      orderBy: (capsuleBranches, { desc }) => [desc(capsuleBranches.createdAt)],
    })
    return rows.map(row => this.mapBranchRow(row))
  }

  public async state(ownerId: string, name: string): Promise<CapsuleBranchServiceItem | null> {
    const row = await this.db.query.capsuleBranches.findFirst({
      where: { name, ownerId },
    })
    return row ? this.mapBranchRow(row) : null
  }

  public async create(ownerId: string, input: CapsuleBranchCreateRequest): Promise<CapsuleCommandAck> {
    return await this.channel.command(CapsuleBranchCommandName.BRANCH_CREATE, {
      target: this.ownerTarget(ownerId),
      name: input.name,
      blueprint: input.blueprint ?? DEFAULT_CAPSULE_BLUEPRINT_NAME,
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

  public async delete(ownerId: string, name: string): Promise<CapsuleCommandAck> {
    return await this.channel.command(CapsuleBranchCommandName.BRANCH_DELETE, {
      target: this.ownerTarget(ownerId),
      name,
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
      ip: row.runtimeIp,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }
}
