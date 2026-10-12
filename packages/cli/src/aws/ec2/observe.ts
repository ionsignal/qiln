import {
  DescribeInternetGatewaysCommand,
  DescribeRouteTablesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  type InternetGateway,
  type IpPermission,
  type RouteTable,
  type SecurityGroup,
  type Subnet,
  type Tag as ProviderTag,
  type Vpc,
} from '@aws-sdk/client-ec2'
import { InstallerError } from '../../diagnostic/error'
import { expectation, groupSpec, matches, resourceId, type Expected } from '../deployment/topology'
import {
  isObservation,
  requiredTags,
  type Deployment,
  type Observation,
  type ObservedResource,
  type Tag,
} from '../deployment/types'
import { collect, poll } from '../observe'
import { AWS_SPEC } from '../spec'
import type { Ec2 } from './client'
import type { Kind } from '../deployment/graph'

type Of<K extends Kind> = Extract<Expected, { kind: K }>

const PAGES = {
  maxPages: AWS_SPEC.deployment.maximumPages,
  code: 'AWS_DEPLOYMENT_VERIFICATION_FAILED',
} as const

const OBSERVATION = {
  ...AWS_SPEC.deployment.observation,
  code: 'AWS_DEPLOYMENT_VERIFICATION_FAILED',
} as const

const ROUTE_FIELDS = ['DestinationCidrBlock', 'GatewayId', 'Origin', 'State']

function unverified(): never {
  throw new InstallerError({
    code: 'AWS_DEPLOYMENT_VERIFICATION_FAILED',
  })
}

function listed<T>(items: readonly T[] | undefined, next: string | undefined): readonly T[] {
  return next === undefined ? (items ?? []) : unverified()
}

function byId(name: string, wanted: readonly { id: string }[]) {
  return [{ Name: name, Values: wanted.map(item => item.id) }]
}

function tagged(actual: readonly ProviderTag[] | undefined, expected: readonly Tag[]): boolean {
  return expected.every(tag => (actual ?? []).some(entry => entry.Key === tag.Key && entry.Value === tag.Value))
}

function onlyFields(value: object, allowed: readonly string[]): boolean {
  return Object.entries(value).every(([key, field]) => field === undefined || allowed.includes(key))
}

function vpcMatches(record: Deployment, vpc: Vpc): boolean {
  const { approval, binding } = record
  const primary = vpc.CidrBlock
  return (
    vpc.State === 'available' &&
    vpc.OwnerId === binding.accountId &&
    primary === approval.cidr &&
    vpc.InstanceTenancy === approval.tenancy &&
    vpc.IsDefault === false &&
    (vpc.CidrBlockAssociationSet ?? []).every(association => association.CidrBlock === primary) &&
    (vpc.Ipv6CidrBlockAssociationSet ?? []).length === 0 &&
    tagged(vpc.Tags, approval.tags)
  )
}

function subnetMatches(record: Deployment, expected: Of<'subnet'>, subnet: Subnet): boolean {
  const zone = record.approval.zones[expected.slot]
  return (
    subnet.State === 'available' &&
    subnet.OwnerId === record.binding.accountId &&
    subnet.VpcId === resourceId(record, 'create-vpc') &&
    subnet.AvailabilityZoneId === zone.id &&
    subnet.CidrBlock === zone.cidr &&
    tagged(subnet.Tags, record.approval.tags) &&
    subnet.DefaultForAz === false &&
    subnet.MapPublicIpOnLaunch === false &&
    subnet.Ipv6Native !== true &&
    (subnet.Ipv6CidrBlockAssociationSet ?? []).length === 0
  )
}

/**
 * The pinned enum names the attached state 'attached', while AWS documents
 * 'available' for internet gateways. Accept either until the walkthrough settles it.
 */
function isAttachedState(state: unknown): boolean {
  return state === 'available' || state === 'attached'
}

function gatewayMatches(record: Deployment, expected: Of<'gateway'>, gateway: InternetGateway): boolean {
  const attachments = gateway.Attachments ?? []
  const attached =
    attachments.length === 1 &&
    attachments[0].VpcId === resourceId(record, 'create-vpc') &&
    isAttachedState(attachments[0].State)
  return (
    gateway.OwnerId === record.binding.accountId &&
    tagged(gateway.Tags, record.approval.tags) &&
    (expected.attached ? attached : attachments.length === 0)
  )
}

function routeTableMatches(record: Deployment, expected: Of<'route-table'>, table: RouteTable): boolean {
  const associations = table.Associations ?? []
  const routes = table.Routes ?? []
  const wanted = [
    { destination: record.approval.cidr, target: 'local', origin: 'CreateRouteTable' },
    ...(expected.routed
      ? [{ destination: '0.0.0.0/0', target: resourceId(record, 'create-gateway'), origin: 'CreateRoute' }]
      : []),
  ]
  return (
    table.OwnerId === record.binding.accountId &&
    table.VpcId === resourceId(record, 'create-vpc') &&
    tagged(table.Tags, record.approval.tags) &&
    (table.PropagatingVgws ?? []).length === 0 &&
    associations.length === expected.associations.length &&
    expected.associations.every(item =>
      associations.some(
        association =>
          association.Main !== true &&
          association.RouteTableAssociationId === item.id &&
          association.SubnetId === item.subnetId &&
          association.GatewayId === undefined &&
          association.AssociationState?.State === 'associated',
      ),
    ) &&
    routes.length === wanted.length &&
    wanted.every(item =>
      routes.some(
        route =>
          route.DestinationCidrBlock === item.destination &&
          route.GatewayId === item.target &&
          route.Origin === item.origin &&
          route.State === 'active' &&
          onlyFields(route, ROUTE_FIELDS),
      ),
    )
  )
}

function allows(permission: IpPermission, protocol: string, port: number | undefined, cidr: string): boolean {
  const ranges = permission.IpRanges ?? []
  return (
    permission.IpProtocol === protocol &&
    permission.FromPort === port &&
    permission.ToPort === port &&
    ranges.length === 1 &&
    ranges[0].CidrIp === cidr &&
    (permission.Ipv6Ranges ?? []).length === 0 &&
    (permission.PrefixListIds ?? []).length === 0 &&
    (permission.UserIdGroupPairs ?? []).length === 0
  )
}

function groupMatches(record: Deployment, expected: Of<'group'>, group: SecurityGroup): boolean {
  const { name, description } = groupSpec(record.id)
  const ingress = group.IpPermissions ?? []
  const egress = group.IpPermissionsEgress ?? []
  return (
    group.OwnerId === record.binding.accountId &&
    group.VpcId === resourceId(record, 'create-vpc') &&
    group.GroupName === name &&
    group.Description === description &&
    tagged(group.Tags, record.approval.tags) &&
    ingress.length === expected.ingress.length &&
    expected.ingress.every(rule => ingress.some(permission => allows(permission, 'tcp', rule.port, rule.cidr))) &&
    // AWS's initial allow-all IPv4 egress rule is retained, never modified.
    egress.length === 1 &&
    allows(egress[0], '-1', undefined, '0.0.0.0/0')
  )
}

/**
 * Absent optional fields are never read as success. A resource expected to be
 * gone is `present` while it exists at all, so deletion is only observed once
 * the provider stops listing it.
 */
function judge<E extends { id: string; present: boolean }, T>(
  kind: Kind,
  wanted: readonly E[],
  found: readonly T[],
  idOf: (item: T) => string | undefined,
  fits: (expected: E, actual: T) => boolean,
): ObservedResource[] {
  const byIdentity = new Map(found.map(item => [idOf(item), item] as const))
  return wanted.map((item): ObservedResource => {
    const actual = byIdentity.get(item.id)
    if (actual === undefined) {
      return { kind, id: item.id, state: 'absent' }
    }
    return { kind, id: item.id, state: !item.present || fits(item, actual) ? 'present' : 'changed' }
  })
}

async function vpcs(ec2: Ec2, record: Deployment, wanted: Of<'vpc'>[], signal?: AbortSignal) {
  if (wanted.length === 0) {
    return []
  }
  const response = await ec2.read(
    (client, call) => client.send(new DescribeVpcsCommand({ Filters: byId('vpc-id', wanted) }), call),
    signal,
  )
  return judge('vpc', wanted, listed(response.Vpcs, response.NextToken), vpc => vpc.VpcId, (_, vpc) =>
    vpcMatches(record, vpc),
  )
}

async function subnets(ec2: Ec2, record: Deployment, wanted: Of<'subnet'>[], signal?: AbortSignal) {
  if (wanted.length === 0) {
    return []
  }
  const response = await ec2.read(
    (client, call) => client.send(new DescribeSubnetsCommand({ Filters: byId('subnet-id', wanted) }), call),
    signal,
  )
  return judge('subnet', wanted, listed(response.Subnets, response.NextToken), subnet => subnet.SubnetId, (item, subnet) =>
    subnetMatches(record, item, subnet),
  )
}

async function gateways(ec2: Ec2, record: Deployment, wanted: Of<'gateway'>[], signal?: AbortSignal) {
  if (wanted.length === 0) {
    return []
  }
  const response = await ec2.read(
    (client, call) =>
      client.send(new DescribeInternetGatewaysCommand({ Filters: byId('internet-gateway-id', wanted) }), call),
    signal,
  )
  return judge(
    'gateway',
    wanted,
    listed(response.InternetGateways, response.NextToken),
    gateway => gateway.InternetGatewayId,
    (item, gateway) => gatewayMatches(record, item, gateway),
  )
}

async function routeTables(ec2: Ec2, record: Deployment, wanted: Of<'route-table'>[], signal?: AbortSignal) {
  if (wanted.length === 0) {
    return []
  }
  const response = await ec2.read(
    (client, call) => client.send(new DescribeRouteTablesCommand({ Filters: byId('route-table-id', wanted) }), call),
    signal,
  )
  return judge(
    'route-table',
    wanted,
    listed(response.RouteTables, response.NextToken),
    table => table.RouteTableId,
    (item, table) => routeTableMatches(record, item, table),
  )
}

async function groups(ec2: Ec2, record: Deployment, wanted: Of<'group'>[], signal?: AbortSignal) {
  if (wanted.length === 0) {
    return []
  }
  const response = await ec2.read(
    (client, call) => client.send(new DescribeSecurityGroupsCommand({ Filters: byId('group-id', wanted) }), call),
    signal,
  )
  return judge('group', wanted, listed(response.SecurityGroups, response.NextToken), group => group.GroupId, (item, group) =>
    groupMatches(record, item, group),
  )
}

/** One graph observation comprises several provider reads, not one atomic read. */
async function snapshot(
  ec2: Ec2,
  record: Deployment,
  expected: readonly Expected[],
  signal?: AbortSignal,
): Promise<Observation> {
  const resources = [
    ...(await vpcs(ec2, record, expected.filter(item => item.kind === 'vpc'), signal)),
    ...(await subnets(ec2, record, expected.filter(item => item.kind === 'subnet'), signal)),
    ...(await gateways(ec2, record, expected.filter(item => item.kind === 'gateway'), signal)),
    ...(await routeTables(ec2, record, expected.filter(item => item.kind === 'route-table'), signal)),
    ...(await groups(ec2, record, expected.filter(item => item.kind === 'group'), signal)),
  ]
  return { observedAt: new Date().toISOString(), resources }
}

/**
 * Judges every recorded resource against the ledger. With `wait` it polls
 * until the whole graph matches, through missing, transitional, and not yet
 * propagated states; without it, one read is returned as observed.
 */
export async function observe(ec2: Ec2, record: Deployment, wait: boolean): Promise<Observation> {
  const expected = expectation(record)
  if (!wait) {
    return await snapshot(ec2, record, expected)
  }
  const seen: { latest: Observation | undefined } = {
    latest: undefined,
  }
  await poll(async signal => {
    const observation = await snapshot(ec2, record, expected, signal)
    seen.latest = observation
    return matches(expected, observation)
  }, OBSERVATION)
  return seen.latest ?? unverified()
}

export async function candidates(ec2: Ec2, record: Deployment): Promise<Observation[]> {
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
  const found = await collect<Vpc>(async marker => {
    const response = await ec2.read((client, call) =>
      client.send(new DescribeVpcsCommand({ Filters: filters, MaxResults: 100, NextToken: marker }), call),
    )
    return {
      items: response.Vpcs ?? [],
      truncated: Boolean(response.NextToken),
      marker: response.NextToken,
    }
  }, PAGES)
  const observations: unknown[] = found.map(vpc => ({
    observedAt: new Date().toISOString(),
    resources: [{ kind: 'vpc', id: vpc.VpcId, state: vpcMatches(record, vpc) ? 'present' : 'changed' }],
  }))
  return observations.every(isObservation) ? observations : unverified()
}
