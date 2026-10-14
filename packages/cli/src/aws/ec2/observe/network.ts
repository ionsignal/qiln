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
  type Vpc,
} from '@aws-sdk/client-ec2'
import type { Expected } from '../../deployment/expect'
import { groupSpec, resourceId } from '../../deployment/topology'
import type { Deployment, ObservedResource } from '../../deployment/types'
import { collect } from '../../observe'
import type { Ec2 } from '../client'
import { byId, judge, listed, PAGES, tagFilters, tagged, type Candidate, type Of } from './shared'

const ROUTE_FIELDS = ['DestinationCidrBlock', 'GatewayId', 'Origin', 'State']

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

export async function observeNetwork(
  ec2: Ec2,
  record: Deployment,
  expected: readonly Expected[],
  signal?: AbortSignal,
): Promise<ObservedResource[]> {
  return [
    ...(await vpcs(ec2, record, expected.filter(item => item.kind === 'vpc'), signal)),
    ...(await subnets(ec2, record, expected.filter(item => item.kind === 'subnet'), signal)),
    ...(await gateways(ec2, record, expected.filter(item => item.kind === 'gateway'), signal)),
    ...(await routeTables(ec2, record, expected.filter(item => item.kind === 'route-table'), signal)),
    ...(await groups(ec2, record, expected.filter(item => item.kind === 'group'), signal)),
  ]
}

export async function networkCandidates(ec2: Ec2, record: Deployment): Promise<Candidate[]> {
  const filters = [{ Name: 'owner-id', Values: [record.binding.accountId] }, ...tagFilters(record)]
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
  return found.map((vpc): Candidate => ({
    kind: 'vpc',
    id: vpc.VpcId,
    state: vpcMatches(record, vpc) ? 'present' : 'changed',
  }))
}
