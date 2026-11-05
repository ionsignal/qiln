import { z } from 'zod'

/**
 * Provider limit refusals, keyed by the error name that the EC2 child sees,
 * with the operator-facing label of the limit. Only per-call limit refusals
 * belong here. Throttling such as `RequestLimitExceeded` does not prove that
 * nothing ran, so it must stay uncertain.
 */
export const QUOTAS = {
  VpcLimitExceeded: 'VPCs per Region',
  SubnetLimitExceeded: 'Subnets per VPC',
  InternetGatewayLimitExceeded: 'Internet gateways per Region',
  RouteTableLimitExceeded: 'Route tables per VPC',
  SecurityGroupLimitExceeded: 'Security groups per Region',
  RulesPerSecurityGroupLimitExceeded: 'Rules per security group',
  InstanceLimitExceeded: 'Running On-Demand instances',
  VcpuLimitExceeded: 'Running On-Demand vCPUs for the instance family',
  VolumeLimitExceeded: 'EBS volume limit',
  MaxIOPSLimitExceeded: 'EBS IOPS in the Region',
  AddressLimitExceeded: 'Elastic IP addresses per Region',
} as const satisfies Record<string, string>

export type Quota = keyof typeof QUOTAS

export function isQuota(value: unknown): value is Quota {
  return typeof value === 'string' && Object.hasOwn(QUOTAS, value)
}

export const quotaSchema = z.custom<Quota>(isQuota)
