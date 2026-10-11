import { CreateVpcCommand, DeleteVpcCommand, DescribeVpcsCommand, EC2Client, type Vpc } from '@aws-sdk/client-ec2'
import { InstallerError } from '../../diagnostic/error'
import { isRecord } from '../guards'
import { collect, poll } from '../observe'
import { AWS_SPEC } from '../spec'
import { isObservation, isVpcId, requiredTags, type Deployment, type Observation } from '../deployment/types'
import type { Until } from './protocol'

const PAGES = {
  maxPages: AWS_SPEC.deployment.maximumPages,
  code: 'AWS_DEPLOYMENT_VERIFICATION_FAILED',
} as const

const OBSERVATION = {
  ...AWS_SPEC.deployment.observation,
  code: 'AWS_DEPLOYMENT_VERIFICATION_FAILED',
} as const

function unverified(): never {
  throw new InstallerError({
    code: 'AWS_DEPLOYMENT_VERIFICATION_FAILED',
  })
}

function byKey(left: { Key?: string }, right: { Key?: string }): number {
  const a = left.Key ?? ''
  const b = right.Key ?? ''
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Optional provider fields are validated by the record guard rather than read
 * as success. Tags are sorted so approved and fresh observations compare equal.
 */
function toObservation(vpc: Vpc): Observation {
  const primary = vpc.CidrBlock
  const candidate: unknown = {
    observedAt: new Date().toISOString(),
    vpcId: vpc.VpcId,
    vpc: {
      state: vpc.State,
      ownerId: vpc.OwnerId,
      cidr: primary,
      tenancy: vpc.InstanceTenancy,
      isDefault: vpc.IsDefault,
      tags: (vpc.Tags ?? []).map(({ Key, Value }) => ({ Key, Value })).sort(byKey),
      // Any association beyond the primary range, including in-flight ones, is conservative.
      extraCidrs:
        (vpc.CidrBlockAssociationSet ?? []).filter(association => association.CidrBlock !== primary).length +
        (vpc.Ipv6CidrBlockAssociationSet ?? []).length,
    },
  }
  return isObservation(candidate) ? candidate : unverified()
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.name === 'InvalidVpcID.NotFound'
}

/**
 * Thin EC2 boundary. Every call is a single attempt; mutations are never
 * polled or retried, and only reads are observed.
 */
export class Ec2 {
  constructor(
    private readonly client: EC2Client,
    private readonly signal: AbortSignal,
  ) {}

  private options(signal?: AbortSignal) {
    return {
      abortSignal: AbortSignal.any([
        this.signal,
        AbortSignal.timeout(AWS_SPEC.requestTimeoutMs),
        ...(signal === undefined ? [] : [signal]),
      ]),
    }
  }

  /** `InvalidVpcID.NotFound` is an absent observation here, and nowhere else. */
  private async describe(vpcId: string, signal?: AbortSignal): Promise<Observation> {
    try {
      const response = await this.client.send(new DescribeVpcsCommand({ VpcIds: [vpcId] }), this.options(signal))
      const vpcs = response.Vpcs ?? []
      if (vpcs.length === 0) {
        return {
          observedAt: new Date().toISOString(),
          vpcId,
          vpc: null,
        }
      }
      const observation = vpcs.length === 1 ? toObservation(vpcs[0]!) : unverified()
      return observation.vpcId === vpcId ? observation : unverified()
    } catch (error: unknown) {
      if (isNotFound(error)) {
        return {
          observedAt: new Date().toISOString(),
          vpcId,
          vpc: null,
        }
      }
      throw error
    }
  }

  /** `any` observes once. The others poll until the VPC leaves its transitional state or disappears. */
  public async observe(vpcId: string, until: Until): Promise<Observation> {
    if (until === 'any') {
      return await this.describe(vpcId)
    }
    const seen: { latest: Observation | undefined } = {
      latest: undefined,
    }
    await poll(async signal => {
      const observation = await this.describe(vpcId, signal)
      seen.latest = observation
      return until === 'absent' ? observation.vpc === null : observation.vpc !== null && observation.vpc.state !== 'pending'
    }, OBSERVATION)
    return seen.latest ?? unverified()
  }

  /** Display-only. Candidates are never adopted, and an empty result proves nothing. */
  public async candidates(record: Deployment): Promise<Observation[]> {
    const filters = [
      {
        Name: 'owner-id',
        Values: [record.binding.accountId],
      },
      ...requiredTags(record.binding.operator.arn, record.id).map(tag => ({
        Name: `tag:${tag.Key}`,
        Values: [tag.Value],
      })),
    ]
    const vpcs = await collect<Vpc>(async marker => {
      const response = await this.client.send(
        new DescribeVpcsCommand({
          Filters: filters,
          MaxResults: 100,
          NextToken: marker,
        }),
        this.options(),
      )
      return {
        items: response.Vpcs ?? [],
        truncated: Boolean(response.NextToken),
        marker: response.NextToken,
      }
    }, PAGES)
    return vpcs.map(toObservation)
  }

  /**
   * The call has no client token, so it is made once. A response without a
   * usable identity cannot be retained and leaves the effect uncertain.
   */
  public async create(record: Deployment): Promise<string> {
    const response = await this.client.send(
      new CreateVpcCommand({
        CidrBlock: record.approval.cidr,
        InstanceTenancy: record.approval.tenancy,
        TagSpecifications: [
          {
            ResourceType: 'vpc',
            Tags: record.approval.tags,
          },
        ],
      }),
      this.options(),
    )
    const vpcId: unknown = response.Vpc?.VpcId
    if (!isVpcId(vpcId)) {
      throw new InstallerError({
        code: 'AWS_DEPLOYMENT_EVIDENCE_UNAVAILABLE',
      })
    }
    return vpcId
  }

  /** The SDK reports no result, so a resolved call establishes only that a response returned. */
  public async delete(vpcId: string): Promise<void> {
    await this.client.send(new DeleteVpcCommand({ VpcId: vpcId }), this.options())
  }
}
