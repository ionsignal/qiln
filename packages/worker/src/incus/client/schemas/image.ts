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

export type IncusImage = z.infer<typeof IncusImageSchema>
