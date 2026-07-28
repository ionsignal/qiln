import { z } from 'zod'

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

export const CAPSULE_ROOTFS_IMAGE_PIN_SCHEMA_VERSION = 1 as const

/**
 * Qiln currently reconstructs capsule rootfs state from exact Incus images.
 *
 * The provider discriminator remains explicit so a future supported runtime
 * provider cannot reinterpret an Incus fingerprint as its own image identity.
 */
export const CapsuleRootfsImageProvider = {
  INCUS: 'incus',
} as const

export type CapsuleRootfsImageProvider = (typeof CapsuleRootfsImageProvider)[keyof typeof CapsuleRootfsImageProvider]

export const CapsuleRootfsImageProviderValues = [CapsuleRootfsImageProvider.INCUS] as const

export const CapsuleRootfsImageProviderSchema = z.enum(CapsuleRootfsImageProviderValues)

/**
 * Incus image fingerprints are immutable SHA-256 identities without the
 * `sha256:` prefix used by Qiln's canonical JSON digest contracts.
 */
export const CapsuleRootfsImageFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/, {
  message: 'Capsule rootfs image fingerprints must contain exactly 64 lowercase hexadecimal characters.',
})

/**
 * Source project containing an immutable base image.
 *
 * A project is provider topology, not Blueprint policy. The pin records the
 * project resolved at operation acceptance so later reconstruction never
 * depends on an ambient Worker default.
 */
export const CapsuleRootfsImageProjectSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(value => !value.includes('/') && !CONTROL_CHARACTER_PATTERN.test(value), {
    message: 'Capsule rootfs image projects must be concrete Incus project identities.',
  })

/**
 * The Blueprint selector used when Qiln resolved the immutable fingerprint.
 *
 * This remains audit evidence only. Fork and route-runtime reconstruction must
 * use `fingerprint`, never resolve this alias again.
 */
export const CapsuleRootfsImageAliasSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(value => !CONTROL_CHARACTER_PATTERN.test(value), {
    message: 'Capsule rootfs image aliases cannot contain control characters.',
  })

/**
 * Immutable rootfs reconstruction authority.
 *
 * The pin is accepted before provider mutation and copied through create,
 * Snapshot Capture, committed snapshot, and fork provenance. A mutable image
 * alias can identify this pin at create acceptance but must never be consulted
 * when rebuilding a branch from committed history.
 */
export const CapsuleRootfsImagePinSchema = z
  .object({
    schemaVersion: z.literal(CAPSULE_ROOTFS_IMAGE_PIN_SCHEMA_VERSION),
    provider: z.literal(CapsuleRootfsImageProvider.INCUS),
    project: CapsuleRootfsImageProjectSchema,
    fingerprint: CapsuleRootfsImageFingerprintSchema,
    sourceAlias: CapsuleRootfsImageAliasSchema,
  })
  .strict()

export type CapsuleRootfsImageFingerprint = z.infer<typeof CapsuleRootfsImageFingerprintSchema>
export type CapsuleRootfsImageProject = z.infer<typeof CapsuleRootfsImageProjectSchema>
export type CapsuleRootfsImageAlias = z.infer<typeof CapsuleRootfsImageAliasSchema>
export type CapsuleRootfsImagePin = z.infer<typeof CapsuleRootfsImagePinSchema>
