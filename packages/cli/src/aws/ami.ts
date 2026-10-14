import { InstallerError } from '../diagnostic/error'
import { isAccountId } from './types'

const IMAGE_ID = /^ami-[0-9a-f]{8,17}$/

export interface ImagePin {
  imageId: string
  ownerId: string
}

export function isImageId(value: unknown): value is string {
  return typeof value === 'string' && IMAGE_ID.test(value)
}

/**
 * Reviewed AMI per permission region.
 */
const AMI_INDEX: Readonly<Record<string, ImagePin>> = Object.freeze({
  'us-west-2': {
    imageId: 'ami-00650bfc1df7d064c',
    ownerId: '898082745236',
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
