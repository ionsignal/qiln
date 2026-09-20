import {
  CapsuleDetailSchema,
  CapsuleListOutputSchema,
  CapsuleReadCommandName,
  TargetType,
  type CapsuleChannel,
  type CapsuleDetail,
  type CapsuleDetailRequest,
  type CapsuleListOutput,
} from '@qiln/core/server'

export type CapsuleDetailInput = Pick<CapsuleDetailRequest, 'capsuleId' | 'branchId'>

/**
 * Thin authenticated integration with Worker-owned capsule projections.
 *
 * Owner identity comes from trusted Host context. Historical provenance,
 * manifest availability, preview evidence, and browser URLs remain Worker
 * responsibilities; this service performs no database or catalog reads.
 */
export class CapsuleReadService {
  constructor(private readonly channel: CapsuleChannel) {}

  public async list(ownerId: string): Promise<CapsuleListOutput> {
    const capsules = await this.channel.command(CapsuleReadCommandName.CAPSULE_LIST, {
      target: {
        type: TargetType.OWNER,
        id: ownerId,
      },
    })
    return CapsuleListOutputSchema.parse(capsules)
  }

  public async detail(ownerId: string, input: CapsuleDetailInput): Promise<CapsuleDetail> {
    const capsule = await this.channel.command(CapsuleReadCommandName.CAPSULE_DETAIL, {
      target: {
        type: TargetType.OWNER,
        id: ownerId,
      },
      capsuleId: input.capsuleId,
      ...(input.branchId === undefined ? {} : { branchId: input.branchId }),
    })
    return CapsuleDetailSchema.parse(capsule)
  }
}
