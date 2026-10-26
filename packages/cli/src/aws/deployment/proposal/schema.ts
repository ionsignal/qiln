import { AWS_SPEC } from '../../spec'
import { isImageId, isSnapshotId } from '../../ami'
import { hasKeys, isRecord } from '../../../guards'
import { isAccountId, isTimestamp } from '../../types'
import { isPlacement } from '../types'
import { DiscoveryError, kindOf, type Issue } from './failure'
import type { Discovery } from './types'

/**
 * Structural validation only. A passing discovery has the expected shape and
 * bounds; it is not established to be compatible or internally consistent.
 * Those judgements belong to `evaluate`.
 *
 * A check returns the first issue it finds, or null. Paths are built only from
 * schema field names and list indices, never from provider-supplied keys.
 */
type Check = (value: unknown, path: string) => Issue | null

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 256
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isFlag(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function fail(path: string, expected: string, value: unknown): Issue {
  return { path, expected, received: kindOf(value) }
}

function scalar(expected: string, accepts: (value: unknown) => boolean): Check {
  return (value, path) => (accepts(value) ? null : fail(path, expected, value))
}

function nullable(check: Check): Check {
  return (value, path) => {
    if (value === null) {
      return null
    }
    const issue = check(value, path)
    // Only a failure of the value itself, not of a nested field, widens to null.
    return issue?.path === path ? { ...issue, expected: `${issue.expected} or null` } : issue
  }
}

function list(check: Check, maximum: number): Check {
  return (value, path) => {
    if (!Array.isArray(value) || value.length > maximum) {
      return fail(path, `list of at most ${maximum}`, value)
    }
    const items: unknown[] = value
    for (const [index, item] of items.entries()) {
      const issue = check(item, `${path}[${index}]`)
      if (issue !== null) {
        return issue
      }
    }
    return null
  }
}

function record(shape: Readonly<Record<string, Check>>): Check {
  const keys = Object.keys(shape)
  return (value, path) => {
    if (!isRecord(value) || !hasKeys(value, keys)) {
      return fail(path, 'record with exact keys', value)
    }
    for (const [key, check] of Object.entries(shape)) {
      const issue = check(value[key], `${path}.${key}`)
      if (issue !== null) {
        return issue
      }
    }
    return null
  }
}

const text = scalar('text', isText)
const count = scalar('count', isCount)
const flag = scalar('boolean', isFlag)
const timestamp = scalar('timestamp', isTimestamp)
const nullableText = nullable(text)
const nullableCount = nullable(count)
const nullableFlag = nullable(flag)
const texts = list(text, 32)

const imageEbs = record({
  snapshotId: nullable(scalar('snapshot ID', isSnapshotId)),
  volumeSizeGiB: nullableCount,
  volumeType: nullableText,
  iops: nullableCount,
  throughput: nullableCount,
  encrypted: nullableFlag,
  deleteOnTermination: nullableFlag,
})

const imageDevice = record({
  deviceName: text,
  virtualName: nullableText,
  noDevice: flag,
  ebs: nullable(imageEbs),
})

const image = record({
  id: scalar('image ID', isImageId),
  ownerId: scalar('account ID', isAccountId),
  name: text,
  createdAt: timestamp,
  architecture: text,
  state: text,
  imageType: text,
  rootDeviceType: text,
  rootDeviceName: nullableText,
  virtualizationType: text,
  enaSupport: nullableFlag,
  bootMode: nullableText,
  deprecationTime: nullable(timestamp),
  productCodes: texts,
  devices: list(imageDevice, AWS_SPEC.compute.discovery.maximumDevices),
})

const gpu = record({
  manufacturer: text,
  name: text,
  count,
  memoryMiB: count,
})

const instanceType = record({
  name: text,
  architectures: texts,
  usageClasses: texts,
  rootDeviceTypes: texts,
  virtualizationTypes: texts,
  bootModes: texts,
  enaSupport: nullableText,
  gpus: list(gpu, 16),
  gpuMemoryMiB: nullableCount,
  vcpus: count,
  memoryMiB: count,
  instanceStorageGB: nullableCount,
  ebsSupport: nullableText,
})

const zoneFields = record({
  id: text,
  name: text,
  state: text,
})

const zone: Check = (value, path) => {
  const issue = zoneFields(value, path)
  if (issue !== null || !isRecord(value)) {
    return issue
  }
  return isPlacement({ id: value.id, name: value.name }) ? null : fail(path, 'zone ID and name', value)
}

const discovery = record({
  discoveredAt: timestamp,
  image: nullable(image),
  instanceType: nullable(instanceType),
  zones: list(zone, AWS_SPEC.compute.discovery.maximumZones),
  offeredZoneIds: list(text, AWS_SPEC.compute.discovery.maximumZones),
})

function discoveryIssue(value: unknown): Issue | null {
  return discovery(value, 'discovery')
}

export function isDiscovery(value: unknown): value is Discovery {
  return discoveryIssue(value) === null
}

export function assertDiscovery(value: unknown): asserts value is Discovery {
  const issue = discoveryIssue(value)
  if (issue !== null) {
    throw new DiscoveryError(issue)
  }
}
