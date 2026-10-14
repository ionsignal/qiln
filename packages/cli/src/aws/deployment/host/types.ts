import { isImageId, type ImagePin } from '../../ami'
import { isRecord } from '../../guards'
import { sameJson } from '../../json'
import { isAccountId, validRegion } from '../../types'
import { validSource } from '../cidr'
import type { Ingress, Placement, Zone } from '../types'
import { planOf, type PlanInputs } from './plan'

/** The reviewed root source, taken from the image's own root mapping. */
export interface RootSource {
  deviceName: string
  snapshotId: string
}

export interface RootVolume extends RootSource {
  volumeType: string
  sizeGiB: number
  iops: number
  throughput: number
  deleteOnTermination: boolean
}

/**
 * `deleteOnTermination` is an expectation, not a request field: the volume is
 * created and attached separately, so retention is verified after attach.
 */
export interface DataVolume {
  deviceName: string
  volumeType: string
  sizeGiB: number
  iops: number
  throughput: number
  deleteOnTermination: boolean
}

export interface PrimaryInterface {
  deviceIndex: number
  networkCardIndex: number
  associatePublicIp: boolean
  deleteOnTermination: boolean
}

export interface Metadata {
  httpEndpoint: string
  httpTokens: string
  httpPutResponseHopLimit: number
  httpProtocolIpv6: string
  instanceMetadataTags: string
}

export interface KeyPolicy {
  algorithm: string
  passphrase: string
  protection: string
}

export interface ElasticIp {
  allowReassociation: boolean
}

/**
 * The complete launch configuration, frozen from reviewed evidence. The host
 * zone is a slot into `zones` and is never changed or replaced by another zone.
 * There is deliberately no instance profile. Qiln-normalized shapes only: the
 * provider mapping belongs to `ec2/`.
 */
export interface HostPlan {
  region: string
  pin: ImagePin
  instanceType: string
  count: number
  purchase: string
  cidr: string
  zones: Zone[]
  hostSlot: number
  ingress: Ingress[]
  root: RootVolume
  data: DataVolume
  network: PrimaryInterface
  metadata: Metadata
  key: KeyPolicy
  elasticIp: ElasticIp
  tagged: string[]
}

function placementsOf(zones: unknown[]): Placement[] | null {
  const placements: Placement[] = []
  for (const zone of zones) {
    if (!isRecord(zone) || typeof zone.id !== 'string' || typeof zone.name !== 'string') {
      return null
    }
    placements.push({ id: zone.id, name: zone.name })
  }
  return placements
}

/**
 * Extracts only the variable inputs of a plan. Everything else is derived, so
 * a stored plan is valid exactly when it equals the plan rebuilt from them.
 */
function inputsOf(value: unknown): PlanInputs | null {
  if (!isRecord(value)) {
    return null
  }
  const { region, pin, root, zones, hostSlot, ingress } = value
  if (
    typeof region !== 'string' ||
    !validRegion(region) ||
    !isRecord(pin) ||
    !isImageId(pin.imageId) ||
    !isAccountId(pin.ownerId) ||
    !isRecord(root) ||
    typeof root.deviceName !== 'string' ||
    typeof root.snapshotId !== 'string' ||
    !Array.isArray(zones) ||
    !Array.isArray(ingress) ||
    typeof hostSlot !== 'number'
  ) {
    return null
  }
  const items: unknown[] = zones
  const placements = placementsOf(items)
  const administrator: unknown = ingress[0]
  const host: unknown = items[hostSlot]
  if (
    placements === null ||
    !isRecord(administrator) ||
    typeof administrator.cidr !== 'string' ||
    !validSource(administrator.cidr) ||
    !isRecord(host) ||
    typeof host.id !== 'string'
  ) {
    return null
  }
  return {
    region,
    pin: { imageId: pin.imageId, ownerId: pin.ownerId },
    administrator: administrator.cidr,
    zones: placements,
    hostZoneId: host.id,
    root: { deviceName: root.deviceName, snapshotId: root.snapshotId },
  }
}

export function isHostPlan(value: unknown): value is HostPlan {
  const inputs = inputsOf(value)
  const expected = inputs === null ? null : planOf(inputs)
  return expected !== null && sameJson(value, expected)
}
