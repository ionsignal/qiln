import { AWS_SPEC } from '../../spec'
import { isSnapshotId } from '../../ami'
import type { RootSource } from '../host/types'
import type { Finding, ImageDevice, ImageEvidence } from './types'

const { storage: policy, launch } = AWS_SPEC.compute

const INSTANCE_STORE_NAME = /^ephemeral[0-9]+$/

type Requirement = readonly [passed: boolean, message: string]

/**
 * - root: the one EBS mapping at the advertised root device name.
 * - ebs: any other EBS mapping, which the proposed launch does not account for.
 * - instance-store: an ephemeral local disk, not durable storage.
 * - suppressed: a NoDevice entry, which is not an active device.
 * - unknown: contradictory or unrecognized fields, which are never admitted.
 */
export type DeviceClass = 'root' | 'ebs' | 'instance-store' | 'suppressed' | 'unknown'

export function classify(device: ImageDevice, rootName: string | null): DeviceClass {
  const { ebs, noDevice, virtualName } = device
  if (ebs !== null) {
    if (noDevice || virtualName !== null) {
      return 'unknown'
    }
    return device.deviceName === rootName ? 'root' : 'ebs'
  }
  if (noDevice) {
    return virtualName === null ? 'suppressed' : 'unknown'
  }
  return virtualName !== null && INSTANCE_STORE_NAME.test(virtualName) ? 'instance-store' : 'unknown'
}

export interface ImageStorage {
  root: RootSource | null
  instanceStore: ImageDevice[]
  findings: Finding[]
}

/**
 * The launch freezes the image's own root snapshot, so the root must name one
 * that passes the same snapshot-ID rule as the durable plan. The compute policy
 * allows exactly one root size, and a snapshot-backed volume cannot be smaller
 * than its snapshot, so a larger advertised root is a contradiction that would
 * be refused at launch. Every mapping is classified, and anything that would
 * add durable storage or cannot be recognized blocks rather than being
 * silently admitted.
 */
export function storageOf(image: ImageEvidence | null): ImageStorage {
  if (image === null) {
    return { root: null, instanceStore: [], findings: [] }
  }
  const devicesOf = (kind: DeviceClass) => image.devices.filter(device => classify(device, image.rootDeviceName) === kind)
  const roots = devicesOf('root')
  const rootDevice = roots.length === 1 ? roots[0] : undefined
  const reportedSnapshot = rootDevice?.ebs?.snapshotId
  const snapshotId = isSnapshotId(reportedSnapshot) ? reportedSnapshot : null
  const sizeGiB = rootDevice?.ebs?.volumeSizeGiB ?? null
  const requirements: readonly Requirement[] = [
    [rootDevice !== undefined, 'The image root mapping is missing or ambiguous.'],
    [
      rootDevice === undefined || snapshotId !== null,
      'The image root mapping has no valid snapshot, so the reviewed root source cannot be preserved.',
    ],
    [rootDevice === undefined || sizeGiB !== null, 'The image root mapping does not report a size.'],
    [
      sizeGiB === null || sizeGiB <= policy.rootSizeGiB,
      `The ${sizeGiB} GiB image root exceeds the ${policy.rootSizeGiB} GiB that the compute policy authorizes, so the launch would be refused.`,
    ],
    [devicesOf('ebs').length === 0, 'The image has additional EBS mappings that the proposed launch does not account for.'],
    [devicesOf('unknown').length === 0, 'The image has block device mappings that Qiln cannot classify.'],
    [
      new Set(image.devices.map(device => device.deviceName)).size === image.devices.length,
      'The image has duplicate block device names.',
    ],
    [
      image.devices.every(device => device.deviceName !== launch.dataDeviceName),
      `An image block device mapping already uses the data volume device name ${launch.dataDeviceName}.`,
    ],
  ]
  const findings = requirements.flatMap(([passed, message]): Finding[] =>
    passed ? [] : [{ severity: 'blocker', message }],
  )
  return {
    root: rootDevice !== undefined && snapshotId !== null ? { deviceName: rootDevice.deviceName, snapshotId } : null,
    instanceStore: devicesOf('instance-store'),
    findings,
  }
}
