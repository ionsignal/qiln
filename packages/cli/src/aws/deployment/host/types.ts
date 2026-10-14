import { isImageId, type ImagePin } from '../../ami'
import { hasKeys, isRecord } from '../../guards'
import { isAccountId, validRegion } from '../../types'
import { validCidr } from '../cidr'
import type { Ingress, Zone } from '../types'

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

const SNAPSHOT_ID = /^snap-[0-9a-f]{8,17}$/

const PLAN_KEYS = [
  'region',
  'pin',
  'instanceType',
  'count',
  'purchase',
  'cidr',
  'zones',
  'hostSlot',
  'ingress',
  'root',
  'data',
  'network',
  'metadata',
  'key',
  'elasticIp',
  'tagged',
] as const

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
    typeof value.snapshotId === 'string' &&
    SNAPSHOT_ID.test(value.snapshotId) &&
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
    isText(value.passphrase) &&
    isText(value.protection)
  )
}

function isElasticIp(value: unknown): value is ElasticIp {
  return isRecord(value) && hasKeys(value, ['allowReassociation']) && isFlag(value.allowReassociation)
}

/**
 * Shape, bounds, and internal consistency only. Nothing here reads the compute
 * constants, so a stored plan keeps its meaning when they change; those
 * constants belong to the record version. Zone and ingress semantics are
 * judged by the approval guard, which requires them to equal its own.
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
    hostSlot,
    ingress,
    root,
    data,
    network,
    metadata,
    key,
    elasticIp,
    tagged,
  } = value
  return (
    typeof region === 'string' &&
    validRegion(region) &&
    isPin(pin) &&
    isText(instanceType) &&
    isPositive(count) &&
    isText(purchase) &&
    typeof cidr === 'string' &&
    validCidr(cidr) &&
    Array.isArray(zones) &&
    zones.length > 0 &&
    zones.every(isZone) &&
    isCount(hostSlot) &&
    hostSlot < zones.length &&
    Array.isArray(ingress) &&
    ingress.length > 0 &&
    ingress.every(isRule) &&
    isRootVolume(root) &&
    isDataVolume(data) &&
    isPrimaryInterface(network) &&
    isMetadata(metadata) &&
    isKeyPolicy(key) &&
    isElasticIp(elasticIp) &&
    Array.isArray(tagged) &&
    tagged.every(isText)
  )
}
