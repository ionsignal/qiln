import {
  CapsuleBranchCommandName,
  DEFAULT_CAPSULE_BLUEPRINT_NAME,
  TargetType,
  type CapsuleBranchStatus,
  type CapsuleChannel,
  type CapsuleCommandAck,
  type TargetOwner,
} from '@qiln/core/server'
import type { HostDbContract } from '../db'

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
  definition: string
  ip: string | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Public-engine capsule branch service.
 *
 * The table is still named `instances` as an internal read model. The service
 * translates that legacy persistence detail into capsule/branch terminology at
 * the API boundary.
 */
export class CapsuleService {
  constructor(
    private readonly db: HostDbContract,
    private readonly channel: CapsuleChannel,
  ) {}

  public async list(ownerId: string): Promise<CapsuleBranchServiceItem[]> {
    const rows = await this.db.query.instances.findMany({
      where: { ownerId },
      orderBy: (instances, { desc }) => [desc(instances.createdAt)],
    })
    return rows.map(row => this.mapBranchRow(row))
  }

  public async state(ownerId: string, name: string): Promise<CapsuleBranchServiceItem | null> {
    const row = await this.db.query.instances.findFirst({
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
      blueprint: row.definition,
      ip: row.ip,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }
}
