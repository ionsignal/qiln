import {
  DescribeAddressesCommand,
  DescribeInstancesCommand,
  DescribeKeyPairsCommand,
  DescribeNetworkInterfacesCommand,
  DescribeVolumesCommand,
  type Address,
  type Instance,
  type NetworkInterface,
  type Volume,
} from '@aws-sdk/client-ec2'
import type { Expected } from '../../deployment/expect'
import { resourceId } from '../../deployment/topology'
import type { Deployment, Implicit, ObservedResource } from '../../deployment/types'
import { collect } from '../../observe'
import type { Ec2 } from '../client'
import { sameFingerprint, type KeyReader } from '../key'
import { byId, judge, listed, PAGES, tagFilters, tagged, type Candidate, type Of } from './shared'

interface Launched {
  ownerId: string | undefined
  instance: Instance
}

function targetOf(record: Deployment) {
  const { host, tags } = record.approval
  const { plan } = host
  return {
    plan,
    tags,
    keyName: host.keyName,
    zone: plan.zones[plan.hostSlot],
    accountId: record.binding.accountId,
    vpcId: resourceId(record, 'create-vpc'),
    subnetId: resourceId(record, 'create-subnet', plan.hostSlot),
    groupId: resourceId(record, 'create-group'),
    instanceId: resourceId(record, 'run-instances'),
  }
}

type Target = ReturnType<typeof targetOf>

const isTerminated = (launched: Launched) => launched.instance.State?.Name === 'terminated'

/**
 * `pending` is neither a fit nor a refusal, so a verifying poll waits through
 * it. Health checks are deliberately not part of this judgement: `running` is
 * never reported as healthy.
 */
function instanceMatches(target: Target, { ownerId, instance }: Launched): boolean {
  const { plan } = target
  const { metadata } = plan
  const options = instance.MetadataOptions
  const groups = instance.SecurityGroups ?? []
  const state = instance.State?.Name
  return (
    (state === 'running' || state === 'stopped') &&
    ownerId === target.accountId &&
    instance.ImageId === plan.pin.imageId &&
    instance.InstanceType === plan.instanceType &&
    instance.KeyName === target.keyName &&
    instance.RootDeviceName === plan.root.deviceName &&
    instance.Placement?.Tenancy === 'default' &&
    instance.Placement.AvailabilityZone === target.zone.name &&
    instance.VpcId === target.vpcId &&
    instance.SubnetId === target.subnetId &&
    instance.IamInstanceProfile === undefined &&
    groups.length === 1 &&
    groups[0].GroupId === target.groupId &&
    options?.State === 'applied' &&
    options.HttpEndpoint === metadata.httpEndpoint &&
    options.HttpTokens === metadata.httpTokens &&
    options.HttpPutResponseHopLimit === metadata.httpPutResponseHopLimit &&
    options.HttpProtocolIpv6 === metadata.httpProtocolIpv6 &&
    options.InstanceMetadataTags === metadata.instanceMetadataTags &&
    tagged(instance.Tags, target.tags)
  )
}

/**
 * The root volume and primary interface exist only if the instance reports
 * exactly one of each, so ambiguity is reported as no relationship at all.
 */
function implicitOf(instance: Instance): Implicit | null {
  const roots = (instance.BlockDeviceMappings ?? []).filter(mapping => mapping.DeviceName === instance.RootDeviceName)
  const interfaces = instance.NetworkInterfaces ?? []
  const rootVolumeId = roots.length === 1 ? roots[0].Ebs?.VolumeId : undefined
  const interfaceId = interfaces.length === 1 ? interfaces[0].NetworkInterfaceId : undefined
  return rootVolumeId !== undefined && interfaceId !== undefined ? { rootVolumeId, interfaceId } : null
}

async function instances(ec2: Ec2, target: Target, wanted: Of<'instance'>[], signal?: AbortSignal) {
  if (wanted.length === 0) {
    return { resources: [], implicit: null }
  }
  const response = await ec2.read(
    (client, call) => client.send(new DescribeInstancesCommand({ Filters: byId('instance-id', wanted) }), call),
    signal,
  )
  const launched = listed(response.Reservations, response.NextToken).flatMap(reservation =>
    (reservation.Instances ?? []).map((instance): Launched => ({ ownerId: reservation.OwnerId, instance })),
  )
  const resources = judge(
    'instance',
    wanted,
    launched,
    item => item.instance.InstanceId,
    (_, item) => instanceMatches(target, item),
    isTerminated,
  )
  const seen = launched.find(item => item.instance.InstanceId === wanted[0].id)
  const implicit: Implicit | null = seen === undefined || isTerminated(seen) ? null : implicitOf(seen.instance)
  return { resources, implicit }
}

/**
 * The root volume is checked against its snapshot-backed launch mapping, and
 * the data volume against its retention setting. Whether the data volume is
 * attached or unattached follows the ledger: after termination it must be
 * present and unattached, never absent.
 */
function volumeMatches(target: Target, expected: Of<'volume'>, volume: Volume): boolean {
  const spec = expected.role === 'root' ? target.plan.root : target.plan.data
  const attachments = volume.Attachments ?? []
  const attachment = attachments[0]
  const attachedAsPlanned =
    attachments.length === 1 &&
    attachment.InstanceId === target.instanceId &&
    attachment.Device === spec.deviceName &&
    attachment.State === 'attached' &&
    attachment.DeleteOnTermination === spec.deleteOnTermination
  return (
    volume.Size === spec.sizeGiB &&
    volume.VolumeType === spec.volumeType &&
    volume.Iops === spec.iops &&
    volume.Throughput === spec.throughput &&
    volume.AvailabilityZone === target.zone.name &&
    tagged(volume.Tags, target.tags) &&
    (expected.role !== 'root' || volume.SnapshotId === target.plan.root.snapshotId) &&
    (expected.attached
      ? volume.State === 'in-use' && attachedAsPlanned
      : volume.State === 'available' && attachments.length === 0)
  )
}

async function volumes(ec2: Ec2, target: Target, wanted: Of<'volume'>[], signal?: AbortSignal) {
  if (wanted.length === 0) {
    return []
  }
  const response = await ec2.read(
    (client, call) => client.send(new DescribeVolumesCommand({ Filters: byId('volume-id', wanted) }), call),
    signal,
  )
  return judge(
    'volume',
    wanted,
    listed(response.Volumes, response.NextToken),
    volume => volume.VolumeId,
    (item, volume) => volumeMatches(target, item, volume),
    volume => volume.State === 'deleted',
  )
}

function interfaceMatches(target: Target, network: NetworkInterface): boolean {
  const groups = network.Groups ?? []
  const attachment = network.Attachment
  return (
    network.OwnerId === target.accountId &&
    network.Status === 'in-use' &&
    network.VpcId === target.vpcId &&
    network.SubnetId === target.subnetId &&
    groups.length === 1 &&
    groups[0].GroupId === target.groupId &&
    attachment !== undefined &&
    attachment.InstanceId === target.instanceId &&
    attachment.DeviceIndex === target.plan.network.deviceIndex &&
    attachment.DeleteOnTermination === target.plan.network.deleteOnTermination &&
    attachment.Status === 'attached' &&
    tagged(network.TagSet, target.tags)
  )
}

async function interfaces(ec2: Ec2, target: Target, wanted: Of<'interface'>[], signal?: AbortSignal) {
  if (wanted.length === 0) {
    return []
  }
  const response = await ec2.read(
    (client, call) =>
      client.send(new DescribeNetworkInterfacesCommand({ Filters: byId('network-interface-id', wanted) }), call),
    signal,
  )
  return judge(
    'interface',
    wanted,
    listed(response.NetworkInterfaces, response.NextToken),
    network => network.NetworkInterfaceId,
    (_, network) => interfaceMatches(target, network),
  )
}

function addressMatches(target: Target, expected: Of<'address'>, address: Address): boolean {
  const { association } = expected
  return (
    address.Domain === 'vpc' &&
    address.PublicIp !== undefined &&
    tagged(address.Tags, target.tags) &&
    address.AssociationId === association?.id &&
    address.NetworkInterfaceId === association?.interfaceId
  )
}

async function addresses(ec2: Ec2, target: Target, wanted: Of<'address'>[], signal?: AbortSignal) {
  if (wanted.length === 0) {
    return []
  }
  const response = await ec2.read(
    (client, call) => client.send(new DescribeAddressesCommand({ Filters: byId('allocation-id', wanted) }), call),
    signal,
  )
  return judge(
    'address',
    wanted,
    response.Addresses ?? [],
    address => address.AllocationId,
    (item, address) => addressMatches(target, item, address),
  )
}

/**
 * The local key is read only while the key pair is expected to exist, and the
 * comparison is against its fingerprint, not just the AWS key name.
 */
async function keyPairs(ec2: Ec2, target: Target, wanted: Of<'key-pair'>[], readKey: KeyReader, signal?: AbortSignal) {
  if (wanted.length === 0) {
    return []
  }
  const fingerprint = wanted.some(item => item.present) ? (await readKey()).fingerprint : null
  const response = await ec2.read(
    (client, call) => client.send(new DescribeKeyPairsCommand({ Filters: byId('key-pair-id', wanted) }), call),
    signal,
  )
  return judge(
    'key-pair',
    wanted,
    response.KeyPairs ?? [],
    pair => pair.KeyPairId,
    (_, pair) =>
      fingerprint !== null &&
      pair.KeyName === target.keyName &&
      pair.KeyType === target.plan.key.algorithm &&
      sameFingerprint(pair.KeyFingerprint, fingerprint) &&
      tagged(pair.Tags, target.tags),
  )
}

/**
 * Judges every recorded host resource against the ledger. Only the instance
 * reports the relationship that names its root volume and primary interface.
 */
export async function observeHost(
  ec2: Ec2,
  record: Deployment,
  expected: readonly Expected[],
  readKey: KeyReader,
  signal?: AbortSignal,
): Promise<{ resources: ObservedResource[]; implicit: Implicit | null }> {
  const target = targetOf(record)
  const pairs = await keyPairs(ec2, target, expected.filter(item => item.kind === 'key-pair'), readKey, signal)
  const launched = await instances(ec2, target, expected.filter(item => item.kind === 'instance'), signal)
  const resources = [
    ...pairs,
    ...launched.resources,
    ...(await volumes(ec2, target, expected.filter(item => item.kind === 'volume'), signal)),
    ...(await interfaces(ec2, target, expected.filter(item => item.kind === 'interface'), signal)),
    ...(await addresses(ec2, target, expected.filter(item => item.kind === 'address'), signal)),
  ]
  return { resources, implicit: launched.implicit }
}

/**
 * Tagged host resources found without a retained identity, for display only.
 * The root volume and primary interface are not listed separately: they are
 * reachable through their instance. A terminated instance or deleted volume is
 * reported absent.
 */
export async function hostCandidates(ec2: Ec2, record: Deployment): Promise<Candidate[]> {
  const filters = tagFilters(record)
  const launched = await collect<Instance>(async marker => {
    const response = await ec2.read((client, call) =>
      client.send(new DescribeInstancesCommand({ Filters: filters, MaxResults: 100, NextToken: marker }), call),
    )
    return {
      items: (response.Reservations ?? []).flatMap(reservation => reservation.Instances ?? []),
      truncated: Boolean(response.NextToken),
      marker: response.NextToken,
    }
  }, PAGES)
  const disks = await collect<Volume>(async marker => {
    const response = await ec2.read((client, call) =>
      client.send(new DescribeVolumesCommand({ Filters: filters, MaxResults: 100, NextToken: marker }), call),
    )
    return {
      items: response.Volumes ?? [],
      truncated: Boolean(response.NextToken),
      marker: response.NextToken,
    }
  }, PAGES)
  const allocated = await ec2.read((client, call) => client.send(new DescribeAddressesCommand({ Filters: filters }), call))
  const pairs = await ec2.read((client, call) => client.send(new DescribeKeyPairsCommand({ Filters: filters }), call))
  return [
    ...launched.map((instance): Candidate => ({
      kind: 'instance',
      id: instance.InstanceId,
      state: instance.State?.Name === 'terminated' ? 'absent' : 'present',
    })),
    ...disks.map((volume): Candidate => ({
      kind: 'volume',
      id: volume.VolumeId,
      state: volume.State === 'deleted' ? 'absent' : 'present',
    })),
    ...(allocated.Addresses ?? []).map((address): Candidate => ({
      kind: 'address',
      id: address.AllocationId,
      state: 'present',
    })),
    ...(pairs.KeyPairs ?? []).map((pair): Candidate => ({
      kind: 'key-pair',
      id: pair.KeyPairId,
      state: 'present',
    })),
  ]
}
