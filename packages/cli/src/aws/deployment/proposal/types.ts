import type { ImagePin } from '../../ami'
import type { HostPlan } from '../host/types'
import type { Placement } from '../types'

export interface ImageEbs {
  snapshotId: string | null
  volumeSizeGiB: number | null
  volumeType: string | null
  iops: number | null
  throughput: number | null
  encrypted: boolean | null
  deleteOnTermination: boolean | null
}

export interface ImageDevice {
  deviceName: string
  virtualName: string | null
  noDevice: boolean
  ebs: ImageEbs | null
}

export interface ImageEvidence {
  id: string
  ownerId: string
  name: string
  createdAt: string
  architecture: string
  state: string
  imageType: string
  rootDeviceType: string
  rootDeviceName: string | null
  virtualizationType: string
  enaSupport: boolean | null
  bootMode: string | null
  deprecationTime: string | null
  productCodes: string[]
  devices: ImageDevice[]
}

export interface GpuEvidence {
  manufacturer: string
  name: string
  count: number
  memoryMiB: number
}

export interface InstanceTypeEvidence {
  name: string
  architectures: string[]
  usageClasses: string[]
  rootDeviceTypes: string[]
  virtualizationTypes: string[]
  bootModes: string[]
  enaSupport: string | null
  gpus: GpuEvidence[]
  gpuMemoryMiB: number | null
  vcpus: number
  memoryMiB: number
  instanceStorageGB: number | null
  ebsSupport: string | null
}

export interface ZoneEvidence extends Placement {
  state: string
}

/**
 * Bounded, normalized read-only evidence from one discovery. The image is the
 * reviewed pin as AWS currently describes it, or null when AWS returned
 * nothing. Offered zone IDs are AZ IDs, not the account-specific zone names.
 * An offering reports where a type is sold; it does not reserve or prove capacity.
 */
export interface Discovery {
  discoveredAt: string
  image: ImageEvidence | null
  instanceType: InstanceTypeEvidence | null
  zones: ZoneEvidence[]
  offeredZoneIds: string[]
}

export interface Finding {
  severity: 'blocker' | 'review'
  message: string
}

/**
 * The in-memory host proposal. It is never persisted and is separate from the
 * durable network-only Deployment record. The plan is the complete frozen
 * launch configuration and exists only when no finding blocks. Instance-store
 * mappings are ephemeral, are not part of the durable plan, and are kept only
 * for display.
 */
export interface HostProposal {
  region: string
  pin: ImagePin
  discoveredAt: string
  image: ImageEvidence | null
  instanceType: InstanceTypeEvidence | null
  excludedZones: ZoneEvidence[]
  instanceStore: ImageDevice[]
  plan: HostPlan | null
  findings: Finding[]
}
