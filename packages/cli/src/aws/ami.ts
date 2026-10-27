import { InstallerError } from '../diagnostic/error'
import { isAccountId } from './types'

const IMAGE_ID = /^ami-[0-9a-f]{8,17}$/
const SNAPSHOT_ID = /^snap-[0-9a-f]{8,17}$/

export interface ImagePin {
  imageId: string
  ownerId: string
}

export function isImageId(value: unknown): value is string {
  return typeof value === 'string' && IMAGE_ID.test(value)
}

/**
 * The one snapshot-ID rule, shared by discovery, proposal evaluation and
 * durable-plan validation. Syntax does not prove that the snapshot exists.
 */
export function isSnapshotId(value: unknown): value is string {
  return typeof value === 'string' && SNAPSHOT_ID.test(value)
}

/**
 * Reviewed AMI per deployment region.
 */
const AMI_INDEX: Readonly<Record<string, ImagePin>> = Object.freeze({
  'us-west-2': {
    ownerId: '099720109477',  // (x86)
    imageId: 'ami-0fb2d44dcddd9fb1b', // (x86)
    // ownerId: '099720109477', // (ARM)
    // imageId: 'ami-04eb8855dfe658eda', // (ARM)
  },
})

export function findPin(region: string): ImagePin | null {
  const pin = Object.hasOwn(AMI_INDEX, region) ? AMI_INDEX[region] : undefined
  if (pin === undefined) {
    return null
  }
  if (!isImageId(pin.imageId) || !isAccountId(pin.ownerId)) {
    throw new InstallerError({
      code: 'INTERNAL_ERROR',
    })
  }
  return pin
}
