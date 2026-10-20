import {
  AllocateAddressCommand,
  AssociateAddressCommand,
  AttachVolumeCommand,
  CreateVolumeCommand,
  DeleteKeyPairCommand,
  DisassociateAddressCommand,
  ImportKeyPairCommand,
  ReleaseAddressCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  type CreateVolumeCommandInput,
  type RunInstancesCommandInput,
} from '@aws-sdk/client-ec2'
import { notAttempted } from '../context'
import { contradicts, need, receipt, tags, unavailable } from './shared'
import { dataVolumeId } from '../../deployment/topology'
import type { Action } from '../../deployment/graph'
import type { Deployment, Step } from '../../deployment/types'
import type { PublicKeyReader } from '../../ssh/store'
import type { Ec2 } from '../client'

const HOST_ACTIONS = [
  'import-key-pair',
  'run-instances',
  'create-volume',
  'attach-volume',
  'allocate-address',
  'associate-address',
  'disassociate-address',
  'release-address',
  'terminate-instance',
  'delete-key-pair',
] as const satisfies readonly Action[]

type HostAction = (typeof HOST_ACTIONS)[number]

export function isHostAction(action: Action): action is HostAction {
  return HOST_ACTIONS.some(candidate => candidate === action)
}

// The plan stores Qiln-normalized strings that were fixed at approval and
// judged structurally by the record guard; the provider models want their
// enums, so these casts only narrow those stored values.
type InstanceTypeName = NonNullable<RunInstancesCommandInput['InstanceType']>
type LaunchMetadata = NonNullable<RunInstancesCommandInput['MetadataOptions']>
type VolumeType = NonNullable<CreateVolumeCommandInput['VolumeType']>

/**
 * The complete frozen launch. Subnet and group live inside the interface entry
 * only, and no instance profile is attached. Anything the ledger cannot supply
 * fails before dispatch.
 */
function launchInput(record: Deployment): RunInstancesCommandInput {
  const { approval } = record
  const { host } = approval
  const { plan } = host
  const { bootstrap, metadata, network, root } = plan
  return {
    ImageId: plan.pin.imageId,
    InstanceType: plan.instanceType as InstanceTypeName,
    MinCount: plan.count,
    MaxCount: plan.count,
    ClientToken: host.launchToken,
    KeyName: host.keyName,
    Placement: { Tenancy: approval.tenancy },
    NetworkInterfaces: [
      {
        DeviceIndex: network.deviceIndex,
        NetworkCardIndex: network.networkCardIndex,
        SubnetId: need(record, 'create-subnet', plan.hostSlot),
        Groups: [need(record, 'create-group')],
        AssociatePublicIpAddress: network.associatePublicIp,
        DeleteOnTermination: network.deleteOnTermination,
      },
    ],
    BlockDeviceMappings: [
      {
        DeviceName: root.deviceName,
        Ebs: {
          VolumeType: root.volumeType as VolumeType,
          VolumeSize: root.sizeGiB,
          Iops: root.iops,
          Throughput: root.throughput,
          DeleteOnTermination: root.deleteOnTermination,
        },
      },
    ],
    MetadataOptions: {
      HttpEndpoint: metadata.httpEndpoint as LaunchMetadata['HttpEndpoint'],
      HttpTokens: metadata.httpTokens as LaunchMetadata['HttpTokens'],
      HttpPutResponseHopLimit: metadata.httpPutResponseHopLimit,
      HttpProtocolIpv6: metadata.httpProtocolIpv6 as LaunchMetadata['HttpProtocolIpv6'],
      InstanceMetadataTags: metadata.instanceMetadataTags as LaunchMetadata['InstanceMetadataTags'],
    },
    UserData: Buffer.from(bootstrap.cloudConfig, 'utf8').toString('base64'),
    TagSpecifications: [
      ...tags(record, 'instance'),
      ...tags(record, 'volume'),
      ...tags(record, 'network-interface'),
    ],
  }
}

/**
 * Sends the single mutating call for one fenced host step and returns the
 * identity it produced, if any. The root volume and primary interface are not
 * named by any mutation response; they are learned from the observation that
 * verifies the launch.
 */
export async function mutateHost(
  ec2: Ec2,
  record: Deployment,
  step: Step,
  readKey: PublicKeyReader,
): Promise<string | null> {
  const { host } = record.approval
  const { plan } = host
  switch (step.action) {
    case 'import-key-pair': {
      const key = await readKey()
      const command = new ImportKeyPairCommand({
        KeyName: host.keyName,
        PublicKeyMaterial: key.bytes,
        TagSpecifications: tags(record, 'key-pair'),
      })
      const response = await ec2.write((client, call) => client.send(command, call))
      if (contradicts(response.KeyName, host.keyName)) {
        return unavailable()
      }
      return receipt(step.action, response.KeyPairId)
    }
    case 'run-instances': {
      const command = new RunInstancesCommand(launchInput(record))
      const response = await ec2.write((client, call) => client.send(command, call))
      const instances = response.Instances ?? []
      if (contradicts(response.OwnerId, record.binding.accountId) || instances.length !== 1) {
        return unavailable()
      }
      return receipt(step.action, instances[0].InstanceId)
    }
    case 'create-volume': {
      const { data } = plan
      const { volume } = host
      if (volume.kind !== 'new') {
        return notAttempted()
      }
      const command = new CreateVolumeCommand({
        AvailabilityZone: plan.zones[plan.hostSlot].name,
        Size: data.sizeGiB,
        VolumeType: data.volumeType as VolumeType,
        Iops: data.iops,
        Throughput: data.throughput,
        ClientToken: volume.token,
        TagSpecifications: tags(record, 'volume'),
      })
      const response = await ec2.write((client, call) => client.send(command, call))
      return receipt(step.action, response.VolumeId)
    }
    case 'attach-volume': {
      const instanceId = need(record, 'run-instances')
      const volumeId = dataVolumeId(record) ?? notAttempted()
      const command = new AttachVolumeCommand({
        InstanceId: instanceId,
        VolumeId: volumeId,
        Device: plan.data.deviceName,
      })
      const response = await ec2.write((client, call) => client.send(command, call))
      if (
        contradicts(response.InstanceId, instanceId) ||
        contradicts(response.VolumeId, volumeId) ||
        contradicts(response.Device, plan.data.deviceName)
      ) {
        return unavailable()
      }
      return null
    }
    case 'allocate-address': {
      const command = new AllocateAddressCommand({
        Domain: 'vpc',
        TagSpecifications: tags(record, 'elastic-ip'),
      })
      const response = await ec2.write((client, call) => client.send(command, call))
      return receipt(step.action, response.AllocationId)
    }
    case 'associate-address': {
      // Bound by the retained interface identity, never by instance, and never moved from another target.
      const command = new AssociateAddressCommand({
        AllocationId: need(record, 'allocate-address'),
        NetworkInterfaceId: record.implicit?.interfaceId ?? notAttempted(),
        AllowReassociation: plan.elasticIp.allowReassociation,
      })
      const response = await ec2.write((client, call) => client.send(command, call))
      return receipt(step.action, response.AssociationId)
    }
    case 'disassociate-address': {
      const command = new DisassociateAddressCommand({ AssociationId: need(record, 'associate-address') })
      await ec2.write((client, call) => client.send(command, call))
      return null
    }
    case 'release-address': {
      const command = new ReleaseAddressCommand({ AllocationId: need(record, 'allocate-address') })
      await ec2.write((client, call) => client.send(command, call))
      return null
    }
    case 'terminate-instance': {
      const instanceId = need(record, 'run-instances')
      const command = new TerminateInstancesCommand({ InstanceIds: [instanceId] })
      const response = await ec2.write((client, call) => client.send(command, call))
      if ((response.TerminatingInstances ?? []).some(change => contradicts(change.InstanceId, instanceId))) {
        return unavailable()
      }
      return null
    }
    case 'delete-key-pair': {
      const keyPairId = need(record, 'import-key-pair')
      const command = new DeleteKeyPairCommand({ KeyPairId: keyPairId })
      const response = await ec2.write((client, call) => client.send(command, call))
      if (response.Return === false || contradicts(response.KeyPairId, keyPairId)) {
        return unavailable()
      }
      return null
    }
    default:
      return notAttempted()
  }
}
