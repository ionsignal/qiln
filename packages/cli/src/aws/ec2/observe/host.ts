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
import { dataTags, hostSlotOf, resourceId } from '../../deployment/topology'
import { collect } from '../../observe'
import { sameFingerprint } from '../../../transport/ssh/key'
import { byId, judge, listed, PAGES, tagFilters, tagged, unverified } from './shared'
import type { Ec2 } from '../client'
import type { Candidate, Of } from './shared'
import type { Expected, Mapping } from '../../deployment/expect'
import type { Deployment, Implicit, ObservedResource } from '../../deployment/types'

interface Launched {
  ownerId: string | undefined
  instance: Instance
}

/**
 * The zone and subnet are those of the newest launch attempt: the launched
 * zone once an instance exists, and the first approved zone before any attempt.
 */
function targetOf(record: Deployment) {
  const { host, tags } = record.approval
  const { plan } = host
  const slot = hostSlotOf(record)
  return {
    plan,
    tags,
    keyName: host.keyName,
    adminKey: record.adminKey,
    dataTags: dataTags(record),
    zone: plan.zones[slot],
    accountId: record.binding.accountId,
    vpcId: resourceId(record, 'create-vpc'),
    subnetId: resourceId(record, 'create-subnet', slot),
    groupId: resourceId(record, 'create-group'),
    instanceId: resourceId(record, 'run-instances'),
  }
}

type Target = ReturnType<typeof targetOf>

const isTerminated = (launched: Launched) => launched.instance.State?.Name === 'terminated'

/**
 * The instance must report exactly the EBS mappings the ledger expects. An
 * unrecorded mapping, which AWS would delete or keep with the instance without
 * Qiln knowing, is never adopted. A mapping still attaching does not fit, so a
 * verifying poll waits through it.
 */
function mappingsMatch(expected: readonly Mapping[], instance: Instance): boolean {
  const reported = instance.BlockDeviceMappings ?? []
  return (
    reported.length === expected.length &&
    expected.every(item =>
      reported.some(
        mapping =>
          mapping.DeviceName === item.deviceName &&
          mapping.Ebs?.Status === 'attached' &&
          mapping.Ebs.DeleteOnTermination === item.deleteOnTermination &&
          (item.volumeId === null || mapping.Ebs.VolumeId === item.volumeId),
      ),
    )
  )
}

/**
 * `pending` is neither a fit nor a refusal, so a verifying poll waits through
 * it. Health checks are deliberately not part of this judgement: `running` is
 * never reported as healthy.
 */
function instanceMatches(target: Target, expected: Of<'instance'>, { ownerId, instance }: Launched): boolean {
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
    mappingsMatch(expected.mappings, instance) &&
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

async function instances(
  ec2: Ec2,
  target: Target,
  wanted: Of<'instance'>[],
  signal?: AbortSignal,
): Promise<{ resources: ObservedResource[]; implicit: Implicit | null }> {
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
    (expected, item) => instanceMatches(target, expected, item),
    isTerminated,
  )
  const seen = launched.find(item => item.instance.InstanceId === wanted[0].id)
  const implicit: Implicit | null = seen === undefined || isTerminated(seen) ? null : implicitOf(seen.instance)
  // Until the launch is verified, no ledger entry names the root volume and
  // interface, so the ones the instance reports are observed here and returned
  // with their actual states. They face the rules they will face once recorded,
  // so a launch is never verified around a root volume that fails them.
  if (wanted[0].present && wanted[0].implicit === null && implicit !== null && resources[0].state === 'present') {
    const discovered = await observeImplicit(ec2, target, implicit, signal)
    const fits = discovered.every(item => item.state === 'present')
    return { resources: [{ ...resources[0], state: fits ? 'present' : 'changed' }, ...discovered], implicit }
  }
  return { resources, implicit }
}

/**
 * The root volume is checked against its snapshot-backed launch mapping, and
 * the data volume against its retention setting. Whether the data volume is
 * attached or unattached follows the ledger: after termination it must be
 * present and unattached, never absent. The data volume carries its own tags,
 * which are not this deployment's when the volume is reused.
 */
function volumeMatches(target: Target, expected: Of<'volume'>, volume: Volume): boolean {
  const spec = expected.role === 'root' ? target.plan.root : target.plan.data
  const tags = expected.role === 'root' ? target.tags : target.dataTags
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
    tagged(volume.Tags, tags) &&
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
  const subnetId = target.subnetId ?? unverified()
  const response = await ec2.read(
    (client, call) =>
      client.send(
        new DescribeNetworkInterfacesCommand({
          Filters: [...byId('network-interface-id', wanted), { Name: 'subnet-id', Values: [subnetId] }],
        }),
        call,
      ),
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

/**
 * Observes the root volume and primary interface that a launching instance
 * reports, by the same rules they face once recorded. Their states are the
 * actual observed ones: an identity that is not listed is absent, and one that
 * does not fit is changed. Identities alone never establish presence.
 */
async function observeImplicit(
  ec2: Ec2,
  target: Target,
  implicit: Implicit,
  signal?: AbortSignal,
): Promise<ObservedResource[]> {
  const root: Of<'volume'> = { kind: 'volume', id: implicit.rootVolumeId, present: true, role: 'root', attached: true }
  const primary: Of<'interface'> = { kind: 'interface', id: implicit.interfaceId, present: true }
  return [...(await volumes(ec2, target, [root], signal)), ...(await interfaces(ec2, target, [primary], signal))]
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
 * The comparison is against the fingerprint recorded in the deployment, never
 * local key files, so a lost key cannot block observation or removal. Without
 * a recorded key nothing can fit.
 */
async function keyPairs(ec2: Ec2, target: Target, wanted: Of<'key-pair'>[], signal?: AbortSignal) {
  if (wanted.length === 0) {
    return []
  }
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
      target.adminKey !== null &&
      pair.KeyName === target.keyName &&
      pair.KeyType === target.plan.key.algorithm &&
      sameFingerprint(pair.KeyFingerprint, target.adminKey.fingerprint) &&
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
  signal?: AbortSignal,
): Promise<{ resources: ObservedResource[]; implicit: Implicit | null }> {
  const target = targetOf(record)
  const pairs = await keyPairs(ec2, target, expected.filter(item => item.kind === 'key-pair'), signal)
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
