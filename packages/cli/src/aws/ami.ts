import { z } from 'zod'
import { InstallerError } from '../diagnostic/error'
import { accountIdSchema } from './types'

const IMAGE_ID = /^ami-[0-9a-f]{8,17}$/
const SNAPSHOT_ID = /^snap-[0-9a-f]{8,17}$/

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

/**
 * The Debian package architecture that goes with each AMI architecture, which
 * is how an Incus installation records the architecture it was prepared on.
 */
const PACKAGE_ARCHITECTURES: Readonly<Record<string, string>> = Object.freeze({
  x86_64: 'amd64',
  arm64: 'arm64',
})

export const imagePinSchema = z.strictObject({
  imageId: z.string().refine(isImageId, 'Expected an image ID.'),
  ownerId: accountIdSchema,
})

export type ImagePin = z.infer<typeof imagePinSchema>

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

export function findPin(region: string): ImagePin | null {
  const pin = Object.hasOwn(AMI_INDEX, region) ? AMI_INDEX[region] : undefined
  if (pin === undefined) {
    return null
  }
  if (!imagePinSchema.safeParse(pin).success) {
    throw new InstallerError({
      code: 'INTERNAL_ERROR',
    })
  }
  return pin
}

/**
 * Null means the AMI architecture has no known package architecture, which
 * never matches a recorded one.
 */
export function packageArchitectureOf(imageArchitecture: string): string | null {
  return Object.hasOwn(PACKAGE_ARCHITECTURES, imageArchitecture) ? PACKAGE_ARCHITECTURES[imageArchitecture] : null
}
