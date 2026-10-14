import { AWS_SPEC } from '../spec'
import {
  DescribeAvailabilityZonesCommand,
  DescribeImagesCommand,
  DescribeInstanceTypeOfferingsCommand,
  DescribeInstanceTypesCommand,
  type BlockDeviceMapping,
  type Image,
  type InstanceTypeInfo,
} from '@aws-sdk/client-ec2'
import { InstallerError } from '../../diagnostic/error'
import { assertDiscovery } from '../deployment/proposal/schema'
import { collect } from '../observe'
import type { Ec2 } from './client'
import type { ImagePin } from '../ami'
import type { Discovery } from '../deployment/proposal/types'

const { compute } = AWS_SPEC

const PAGES = {
  maxPages: AWS_SPEC.deployment.maximumPages,
  code: 'AWS_DEPLOYMENT_DISCOVERY_FAILED',
} as const

function incomplete(): never {
  throw new InstallerError({
    code: 'AWS_DEPLOYMENT_DISCOVERY_FAILED',
  })
}

/**
 * Absent optional fields stay null rather than receiving a success default. An
 * unparseable value is passed through unchanged so the discovery guard rejects it.
 */
function timestamp(value: string | undefined): string | null {
  if (value === undefined) {
    return null
  }
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : value
}

function deviceEvidence(mapping: BlockDeviceMapping) {
  const ebs = mapping.Ebs
  return {
    deviceName: mapping.DeviceName,
    virtualName: mapping.VirtualName ?? null,
    noDevice: mapping.NoDevice !== undefined,
    ebs:
      ebs === undefined
        ? null
        : {
            snapshotId: ebs.SnapshotId ?? null,
            volumeSizeGiB: ebs.VolumeSize ?? null,
            volumeType: ebs.VolumeType ?? null,
            iops: ebs.Iops ?? null,
            throughput: ebs.Throughput ?? null,
            encrypted: ebs.Encrypted ?? null,
            deleteOnTermination: ebs.DeleteOnTermination ?? null,
          },
  }
}

function imageEvidence(image: Image) {
  return {
    id: image.ImageId,
    ownerId: image.OwnerId,
    name: image.Name,
    createdAt: timestamp(image.CreationDate),
    architecture: image.Architecture,
    state: image.State,
    imageType: image.ImageType,
    rootDeviceType: image.RootDeviceType,
    rootDeviceName: image.RootDeviceName ?? null,
    virtualizationType: image.VirtualizationType,
    enaSupport: image.EnaSupport ?? null,
    bootMode: image.BootMode ?? null,
    deprecationTime: timestamp(image.DeprecationTime),
    productCodes: (image.ProductCodes ?? []).map(code => code.ProductCodeId),
    devices: (image.BlockDeviceMappings ?? []).map(deviceEvidence),
  }
}

function instanceTypeEvidence(info: InstanceTypeInfo) {
  return {
    name: info.InstanceType,
    architectures: info.ProcessorInfo?.SupportedArchitectures ?? [],
    usageClasses: info.SupportedUsageClasses ?? [],
    rootDeviceTypes: info.SupportedRootDeviceTypes ?? [],
    virtualizationTypes: info.SupportedVirtualizationTypes ?? [],
    bootModes: info.SupportedBootModes ?? [],
    enaSupport: info.NetworkInfo?.EnaSupport ?? null,
    gpus: (info.GpuInfo?.Gpus ?? []).map(gpu => ({
      manufacturer: gpu.Manufacturer,
      name: gpu.Name,
      count: gpu.Count,
      memoryMiB: gpu.MemoryInfo?.SizeInMiB,
    })),
    gpuMemoryMiB: info.GpuInfo?.TotalGpuMemoryInMiB ?? null,
    vcpus: info.VCpuInfo?.DefaultVCpus,
    memoryMiB: info.MemoryInfo?.SizeInMiB,
    instanceStorageGB: info.InstanceStorageInfo?.TotalSizeInGB ?? null,
    ebsSupport: info.EbsInfo?.EbsOptimizedSupport ?? null,
  }
}

/**
 * Describes only the reviewed pin. `ImageIds` is always one validated ID: an
 * absent or empty list would describe whatever images are visible instead.
 * Deprecated images are included because an explicit ID is otherwise
 * inconsistent about them; the evaluation judges deprecation. Filters and
 * paging are omitted, and the returned ID and owner are judged by the evaluation.
 */
async function findImage(ec2: Ec2, pin: ImagePin) {
  const response = await ec2.read((client, call) =>
    client.send(
      new DescribeImagesCommand({
        ImageIds: [pin.imageId],
        Owners: [compute.image.owner],
        IncludeDeprecated: true,
      }),
      call,
    ),
  )
  const images = response.Images ?? []
  if (response.NextToken || images.length > 1) {
    return incomplete()
  }
  const [image] = images
  return image === undefined ? null : imageEvidence(image)
}

async function findInstanceType(ec2: Ec2) {
  const response = await ec2.read((client, call) =>
    client.send(new DescribeInstanceTypesCommand({ InstanceTypes: [compute.instanceType] }), call),
  )
  const types = response.InstanceTypes ?? []
  if (response.NextToken || types.length > 1) {
    return incomplete()
  }
  const [info] = types
  return info === undefined ? null : instanceTypeEvidence(info)
}

async function listZones(ec2: Ec2) {
  const response = await ec2.read((client, call) =>
    client.send(
      new DescribeAvailabilityZonesCommand({
        AllAvailabilityZones: false,
        Filters: [{ Name: 'zone-type', Values: ['availability-zone'] }],
      }),
      call,
    ),
  )
  return (response.AvailabilityZones ?? []).map(zone => ({
    id: zone.ZoneId,
    name: zone.ZoneName,
    state: zone.State,
  }))
}

async function listOfferedZoneIds(ec2: Ec2) {
  const offerings = await collect(async marker => {
    const response = await ec2.read((client, call) =>
      client.send(
        new DescribeInstanceTypeOfferingsCommand({
          LocationType: 'availability-zone-id',
          Filters: [{ Name: 'instance-type', Values: [compute.instanceType] }],
          MaxResults: 100,
          NextToken: marker,
        }),
        call,
      ),
    )
    return {
      items: response.InstanceTypeOfferings ?? [],
      truncated: Boolean(response.NextToken),
      marker: response.NextToken,
    }
  }, PAGES)
  return offerings.flatMap(offering =>
    offering.InstanceType === compute.instanceType && offering.Location !== undefined ? [offering.Location] : [],
  )
}

/**
 * Read-only launch prerequisite discovery. The normalized result is validated
 * by the same schema the parent applies, so malformed provider data fails here
 * with the first rejected field named.
 */
export async function discover(ec2: Ec2, pin: ImagePin): Promise<Discovery> {
  const image = await findImage(ec2, pin)
  const instanceType = await findInstanceType(ec2)
  const zones = await listZones(ec2)
  const offeredZoneIds = await listOfferedZoneIds(ec2)
  const discovery: unknown = {
    discoveredAt: new Date().toISOString(),
    image,
    instanceType,
    zones,
    offeredZoneIds,
  }
  assertDiscovery(discovery)
  return discovery
}
