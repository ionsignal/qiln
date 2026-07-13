import {
  CapsuleBootstrapCommandName,
  CapsuleLifecycleCommandName,
  DEFAULT_CAPSULE_BLUEPRINT_NAME,
  TargetType,
  type CapsuleArchiveOutput,
  type CapsuleBlueprintDigest,
  type CapsuleBootstrapCreateOutput,
  type CapsuleChannel,
  type CapsuleDestroyOutput,
  type CapsuleLifecycleIdempotencyKey,
  type CapsuleUnarchiveOutput,
  type TargetOwner,
} from '@qiln/core/server'

export interface CapsuleCreateRequest {
  rootBranchName: string
  idempotencyKey: CapsuleLifecycleIdempotencyKey
  blueprintName?: string
  blueprintDigest: CapsuleBlueprintDigest
  cpu?: string
  memory?: string
}

/**
 * Public Engine boundary for capsule-level lifecycle operations.
 *
 * The Engine derives owner targets from the authenticated user and delegates all durable mutations to
 * the Worker through the Capsule Channel. Provider policy, durable accounting, and lifecycle mutation
 * fences remain Worker-owned.
 */
export class CapsuleLifecycleService {
  constructor(private readonly channel: CapsuleChannel) {}

  public async create(ownerId: string, input: CapsuleCreateRequest): Promise<CapsuleBootstrapCreateOutput> {
    return await this.channel.command(CapsuleBootstrapCommandName.BOOTSTRAP_CREATE, {
      target: this.ownerTarget(ownerId),
      bootstrapBranchName: input.rootBranchName,
      idempotencyKey: input.idempotencyKey,
      blueprintName: input.blueprintName ?? DEFAULT_CAPSULE_BLUEPRINT_NAME,
      blueprintDigest: input.blueprintDigest,
      cpu: input.cpu ?? '4',
      memory: input.memory ?? '4GB',
    })
  }

  public async archive(ownerId: string, capsuleId: string, idempotencyKey: CapsuleLifecycleIdempotencyKey): Promise<CapsuleArchiveOutput> {
    return await this.channel.command(CapsuleLifecycleCommandName.CAPSULE_ARCHIVE, {
      target: this.ownerTarget(ownerId),
      capsuleId,
      idempotencyKey,
    })
  }

  public async unarchive(ownerId: string, capsuleId: string, idempotencyKey: CapsuleLifecycleIdempotencyKey): Promise<CapsuleUnarchiveOutput> {
    return await this.channel.command(CapsuleLifecycleCommandName.CAPSULE_UNARCHIVE, {
      target: this.ownerTarget(ownerId),
      capsuleId,
      idempotencyKey,
    })
  }

  public async destroy(ownerId: string, capsuleId: string, idempotencyKey: CapsuleLifecycleIdempotencyKey): Promise<CapsuleDestroyOutput> {
    return await this.channel.command(CapsuleLifecycleCommandName.CAPSULE_DESTROY, {
      target: this.ownerTarget(ownerId),
      capsuleId,
      idempotencyKey,
    })
  }

  private ownerTarget(ownerId: string): TargetOwner {
    return {
      type: TargetType.OWNER,
      id: ownerId,
    }
  }
}
