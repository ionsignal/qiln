import { z } from 'zod'
import { CapsuleRootfsImageFingerprintSchema } from '@qiln/core/server'

/**
 * Narrow immutable image identity returned by Incus image reads.
 *
 * Qiln resolves a mutable Blueprint alias only at create acceptance. Later
 * branch reconstruction verifies and uses this full fingerprint directly.
 */
export const IncusImageSchema = z
  .object({
    fingerprint: CapsuleRootfsImageFingerprintSchema,
  })
  .loose()

/**
 * Narrow alias identity returned by the Incus image-alias API.
 *
 * Alias resolution is allowed only at create acceptance. `target` is the
 * immutable full fingerprint Qiln persists as rootfs reconstruction authority.
 */
export const IncusImageAliasSchema = z
  .object({
    target: CapsuleRootfsImageFingerprintSchema,
  })
  .loose()

export type IncusImage = z.infer<typeof IncusImageSchema>
export type IncusImageAlias = z.infer<typeof IncusImageAliasSchema>
