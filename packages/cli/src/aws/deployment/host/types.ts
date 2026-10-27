import { isImageId, isSnapshotId, type ImagePin } from '../../ami'
import { hasKeys, isRecord } from '../../../guards'
import { isAccountId, validRegion } from '../../types'
import { validCidr } from '../cidr'
import type { Ingress, Zone } from '../types'
import { isBootstrap, type Bootstrap } from './bootstrap'

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
 * The complete launch configuration, frozen from reviewed evidence. The launch
 * candidates are slots into `zones`, in ascending zone ID order, and each is
 * tried once. They are never changed or replaced by another zone.
 * There is deliberately no instance profile. The bootstrap is the exact
 * cloud-init user-data the launch sends. Qiln-normalized shapes only: the
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
  hostSlots: number[]
  ingress: Ingress[]
  root: RootVolume
  data: DataVolume
  network: PrimaryInterface
  metadata: Metadata
  key: KeyPolicy
  bootstrap: Bootstrap
  elasticIp: ElasticIp
  tagged: string[]
}

const PLAN_KEYS = [
  'region',
  'pin',
  'instanceType',
  'count',
  'purchase',
  'cidr',
  'zones',
  'hostSlots',
  'ingress',
  'root',
  'data',
  'network',
  'metadata',
  'key',
  'bootstrap',
  'elasticIp',
  'tagged',
] as const

/**
 * Literals of the record version, not reads of today's spec. Generation always
 * uses an empty passphrase, and the protection text never implies encryption.
 */
const KEY_PASSPHRASE = 'none'
const KEY_PROTECTION = 'owner-only directory 0700, file 0600'

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 256
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositive(value: unknown): value is number {
  return isCount(value) && value > 0
}

function isFlag(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isPin(value: unknown): value is ImagePin {
  return isRecord(value) && hasKeys(value, ['imageId', 'ownerId']) && isImageId(value.imageId) && isAccountId(value.ownerId)
}

function isZone(value: unknown): value is Zone {
  return (
    isRecord(value) &&
    hasKeys(value, ['id', 'name', 'cidr']) &&
    isText(value.id) &&
    isText(value.name) &&
    isText(value.cidr)
  )
}

/**
 * At least one slot, each inside the zones, strictly ascending so the order is
 * the zone ID order that the zones themselves keep.
 */
function isCandidateSlots(value: unknown, zoneCount: number): boolean {
  if (!Array.isArray(value) || value.length === 0) {
    return false
  }
  const slots: unknown[] = value
  let previous = -1
  return slots.every(slot => {
    if (!isCount(slot) || slot >= zoneCount || slot <= previous) {
      return false
    }
    previous = slot
    return true
  })
}

function isRule(value: unknown): value is Ingress {
  return (
    isRecord(value) &&
    hasKeys(value, ['port', 'cidr']) &&
    isPositive(value.port) &&
    value.port <= 65_535 &&
    isText(value.cidr)
  )
}

function hasVolumeFields(volume: Record<string, unknown>): boolean {
  return (
    isText(volume.deviceName) &&
    isText(volume.volumeType) &&
    isPositive(volume.sizeGiB) &&
    isPositive(volume.iops) &&
    isPositive(volume.throughput) &&
    isFlag(volume.deleteOnTermination)
  )
}

function isRootVolume(value: unknown): value is RootVolume {
  return (
    isRecord(value) &&
    hasKeys(value, ['deviceName', 'snapshotId', 'volumeType', 'sizeGiB', 'iops', 'throughput', 'deleteOnTermination']) &&
    isSnapshotId(value.snapshotId) &&
    hasVolumeFields(value)
  )
}

function isDataVolume(value: unknown): value is DataVolume {
  return (
    isRecord(value) &&
    hasKeys(value, ['deviceName', 'volumeType', 'sizeGiB', 'iops', 'throughput', 'deleteOnTermination']) &&
    hasVolumeFields(value)
  )
}

function isPrimaryInterface(value: unknown): value is PrimaryInterface {
  return (
    isRecord(value) &&
    hasKeys(value, ['deviceIndex', 'networkCardIndex', 'associatePublicIp', 'deleteOnTermination']) &&
    isCount(value.deviceIndex) &&
    isCount(value.networkCardIndex) &&
    isFlag(value.associatePublicIp) &&
    isFlag(value.deleteOnTermination)
  )
}

function isMetadata(value: unknown): value is Metadata {
  return (
    isRecord(value) &&
    hasKeys(value, ['httpEndpoint', 'httpTokens', 'httpPutResponseHopLimit', 'httpProtocolIpv6', 'instanceMetadataTags']) &&
    isText(value.httpEndpoint) &&
    isText(value.httpTokens) &&
    isPositive(value.httpPutResponseHopLimit) &&
    isText(value.httpProtocolIpv6) &&
    isText(value.instanceMetadataTags)
  )
}

function isKeyPolicy(value: unknown): value is KeyPolicy {
  return (
    isRecord(value) &&
    hasKeys(value, ['algorithm', 'passphrase', 'protection']) &&
    isText(value.algorithm) &&
    value.passphrase === KEY_PASSPHRASE &&
    value.protection === KEY_PROTECTION
  )
}

function isElasticIp(value: unknown): value is ElasticIp {
  return isRecord(value) && hasKeys(value, ['allowReassociation']) && isFlag(value.allowReassociation)
}

/**
 * Shape, bounds, internal consistency, and the lifecycle invariants that every
 * deployment must keep: one instance, root volume and primary interface deleted
 * with it, a data volume retained on its own device name, an Ed25519
 * administrative key without a passphrase, and the exact approved bootstrap.
 * These are literals of the record version, not today's compute constants, so
 * a stored plan keeps its meaning when they change. Zone and ingress semantics
 * are judged by the approval guard, which requires them to equal its own.
 */
export function isHostPlan(value: unknown): value is HostPlan {
  if (!isRecord(value) || !hasKeys(value, PLAN_KEYS)) {
    return false
  }
  const {
    region,
    pin,
    instanceType,
    count,
    purchase,
    cidr,
    zones,
    hostSlots,
    ingress,
    root,
    data,
    network,
    metadata,
    key,
    bootstrap,
    elasticIp,
    tagged,
  } = value
  return (
    typeof region === 'string' &&
    validRegion(region) &&
    isPin(pin) &&
    isText(instanceType) &&
    count === 1 &&
    isText(purchase) &&
    typeof cidr === 'string' &&
    validCidr(cidr) &&
    Array.isArray(zones) &&
    zones.length > 0 &&
    zones.every(isZone) &&
    isCandidateSlots(hostSlots, zones.length) &&
    Array.isArray(ingress) &&
    ingress.length > 0 &&
    ingress.every(isRule) &&
    isRootVolume(root) &&
    isDataVolume(data) &&
    isPrimaryInterface(network) &&
    isMetadata(metadata) &&
    isKeyPolicy(key) &&
    isBootstrap(bootstrap) &&
    isElasticIp(elasticIp) &&
    Array.isArray(tagged) &&
    tagged.every(isText) &&
    root.deleteOnTermination &&
    network.deleteOnTermination &&
    !data.deleteOnTermination &&
    root.deviceName !== data.deviceName &&
    key.algorithm === 'ed25519'
  )
}
