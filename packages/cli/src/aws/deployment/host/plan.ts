import type { ImagePin } from '../../ami'
import { AWS_SPEC } from '../../spec'
import type { Placement } from '../layout'
import { allocate, ingressRules } from '../topology'
import { bootstrapOf } from './bootstrap'
import type { HostPlan, RootSource } from './types'

const { compute, deployment } = AWS_SPEC
const { launch, storage } = compute

export interface PlanInputs {
  region: string
  pin: ImagePin
  administrator: string
  zones: readonly Placement[]
  hostZoneIds: readonly string[]
  root: RootSource
}

/**
 * Pure freeze of one reviewed proposal into a launch configuration. Every
 * constant comes from the spec, so the plan and the compute policy cannot
 * diverge. Null means a launch zone is not among the allocated zones.
 */
export function planOf(inputs: PlanInputs): HostPlan | null {
  const zones = allocate(deployment.defaultCidr, inputs.zones)
  const hostSlots = zones.flatMap((zone, slot) => (inputs.hostZoneIds.includes(zone.id) ? [slot] : []))
  if (
    hostSlots.length === 0 ||
    hostSlots.length !== inputs.hostZoneIds.length ||
    zones.length > deployment.maximumZones
  ) {
    return null
  }
  const volume = {
    volumeType: storage.volumeType,
    iops: storage.iops,
    throughput: storage.throughput,
  }
  return {
    zones,
    hostSlots,
    region: inputs.region,
    pin: { imageId: inputs.pin.imageId, ownerId: inputs.pin.ownerId },
    instanceType: compute.defaultInstanceType,
    count: launch.count,
    purchase: launch.purchase,
    cidr: deployment.defaultCidr,
    ingress: ingressRules(inputs.administrator),
    root: {
      deviceName: inputs.root.deviceName,
      snapshotId: inputs.root.snapshotId,
      ...volume,
      sizeGiB: storage.rootSizeGiB,
      deleteOnTermination: launch.rootDeleteOnTermination,
    },
    data: {
      deviceName: launch.dataDeviceName,
      ...volume,
      sizeGiB: storage.dataSizeGiB,
      deleteOnTermination: launch.dataDeleteOnTermination,
    },
    network: { ...launch.network },
    metadata: { ...launch.metadata },
    key: { ...launch.key },
    bootstrap: bootstrapOf(),
    elasticIp: { ...launch.elasticIp },
    tagged: [...launch.tagged],
  }
}
