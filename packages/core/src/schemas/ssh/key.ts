import { z } from 'zod'

export const MAX_SSH_PUBLIC_KEY_LINE_LENGTH = 16 * 1024
export const MAX_SSH_PUBLIC_KEY_BLOB_LENGTH = 16 * 1024
export const MAX_SSH_PUBLIC_KEY_LABEL_LENGTH = 128

const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const OPENSSH_SHA256_FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

/**
 * Normal OpenSSH public-key algorithms accepted by the MVP.
 *
 * SSH certificates, FIDO/security-key algorithms, DSA, and arbitrary extension
 * algorithms are deliberately excluded.
 *
 * For RSA keys, `ssh-rsa` identifies the key blob format. It does not authorize
 * the deprecated SSH-RSA/SHA-1 signature algorithm. Signature-algorithm policy
 * remains the responsibility of the SSH gateway.
 */
export const SshPublicKeyAlgorithm = {
  ED25519: 'ssh-ed25519',
  RSA: 'ssh-rsa',
  ECDSA_NISTP256: 'ecdsa-sha2-nistp256',
  ECDSA_NISTP384: 'ecdsa-sha2-nistp384',
  ECDSA_NISTP521: 'ecdsa-sha2-nistp521',
} as const

export type SshPublicKeyAlgorithm = (typeof SshPublicKeyAlgorithm)[keyof typeof SshPublicKeyAlgorithm]

export const SshPublicKeyAlgorithmValues = [
  SshPublicKeyAlgorithm.ED25519,
  SshPublicKeyAlgorithm.RSA,
  SshPublicKeyAlgorithm.ECDSA_NISTP256,
  SshPublicKeyAlgorithm.ECDSA_NISTP384,
  SshPublicKeyAlgorithm.ECDSA_NISTP521,
] as const

export const SshPublicKeyAlgorithmSchema = z.enum(SshPublicKeyAlgorithmValues)

/**
 * Canonical base64 encoding of the complete SSH wire-format public-key blob.
 *
 * Structural parsing and canonical round-trip verification belong to the
 * Node-only `@qiln/ssh` package. This shared schema provides a bounded
 * transport and persistence contract after that parsing succeeds.
 */
export const SshPublicKeyBlobSchema = z
  .string()
  .min(1)
  .max(MAX_SSH_PUBLIC_KEY_BLOB_LENGTH)
  .regex(CANONICAL_BASE64_PATTERN, {
    message: 'SSH public-key blobs must use canonical standard base64 encoding.',
  })

/**
 * Canonical OpenSSH SHA-256 public-key fingerprint.
 *
 * The fingerprint omits base64 padding, matching `ssh-keygen -lf` output.
 * Authorization must still compare the complete canonical public-key blob.
 */
export const SshPublicKeyFingerprintSchema = z.string().regex(OPENSSH_SHA256_FINGERPRINT_PATTERN, {
  message: "SSH public-key fingerprints must use OpenSSH's 'SHA256:<base64-without-padding>' format.",
})

export const SshPublicKeyLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SSH_PUBLIC_KEY_LABEL_LENGTH)
  .refine(value => !CONTROL_CHARACTER_PATTERN.test(value), {
    message: 'SSH public-key labels cannot contain control characters.',
  })

/**
 * User-supplied normal OpenSSH public-key line.
 *
 * `@qiln/ssh` must parse this value and discard any untrusted comment before
 * producing canonical key identity.
 */
export const SshPublicKeyRegistrationInputSchema = z
  .object({
    publicKey: z
      .string()
      .trim()
      .min(1)
      .max(MAX_SSH_PUBLIC_KEY_LINE_LENGTH)
      .refine(value => !value.includes('\0') && !value.includes('\r') && !value.includes('\n'), {
        message: 'An SSH public key must be supplied as one line.',
      }),
    label: SshPublicKeyLabelSchema.optional(),
  })
  .strict()

/**
 * Exact canonical identity derived from the actually parsed or offered key.
 *
 * Host authorization must compare `algorithm` and `publicKeyBlob` against the
 * registered key. Fingerprint equality alone is never authorization.
 */
export const SshCanonicalPublicKeySchema = z
  .object({
    algorithm: SshPublicKeyAlgorithmSchema,
    publicKeyBlob: SshPublicKeyBlobSchema,
    fingerprint: SshPublicKeyFingerprintSchema,
  })
  .strict()

export const SshPublicKeyStatus = {
  ACTIVE: 'active',
  REVOKED: 'revoked',
} as const

export type SshPublicKeyStatus = (typeof SshPublicKeyStatus)[keyof typeof SshPublicKeyStatus]

export const SshPublicKeyStatusValues = [SshPublicKeyStatus.ACTIVE, SshPublicKeyStatus.REVOKED] as const
export const SshPublicKeyStatusSchema = z.enum(SshPublicKeyStatusValues)

export const SshTimestampSchema = z.string().datetime({
  offset: true,
})

/**
 * Client-safe registered SSH public-key summary.
 *
 * The complete key blob remains server-side because clients need only the
 * algorithm, canonical fingerprint, status, and optional label.
 */
export const SshPublicKeySummarySchema = z
  .object({
    id: z.uuid(),
    ownerUserId: z.uuid(),
    algorithm: SshPublicKeyAlgorithmSchema,
    fingerprint: SshPublicKeyFingerprintSchema,
    label: SshPublicKeyLabelSchema.nullable(),
    status: SshPublicKeyStatusSchema,
    createdAt: SshTimestampSchema,
    revokedAt: SshTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((key, context) => {
    if (key.status === SshPublicKeyStatus.ACTIVE && key.revokedAt !== null) {
      context.addIssue({
        code: 'custom',
        path: ['revokedAt'],
        message: 'An active SSH public key cannot have a revocation timestamp.',
      })
    }
    if (key.status === SshPublicKeyStatus.REVOKED && key.revokedAt === null) {
      context.addIssue({
        code: 'custom',
        path: ['revokedAt'],
        message: 'A revoked SSH public key requires a revocation timestamp.',
      })
    }
  })

export const SshPublicKeyRegistrationOutputSchema = SshPublicKeySummarySchema

export const SshPublicKeyRevokeInputSchema = z
  .object({
    publicKeyId: z.uuid(),
  })
  .strict()

export type SshPublicKeyBlob = z.infer<typeof SshPublicKeyBlobSchema>
export type SshPublicKeyFingerprint = z.infer<typeof SshPublicKeyFingerprintSchema>
export type SshPublicKeyLabel = z.infer<typeof SshPublicKeyLabelSchema>
export type SshPublicKeyRegistrationInput = z.input<typeof SshPublicKeyRegistrationInputSchema>
export type SshPublicKeyRegistration = z.output<typeof SshPublicKeyRegistrationInputSchema>
export type SshCanonicalPublicKey = z.infer<typeof SshCanonicalPublicKeySchema>
export type SshTimestamp = z.infer<typeof SshTimestampSchema>
export type SshPublicKeySummary = z.infer<typeof SshPublicKeySummarySchema>
export type SshPublicKeyRegistrationOutput = z.infer<typeof SshPublicKeyRegistrationOutputSchema>
export type SshPublicKeyRevokeInput = z.infer<typeof SshPublicKeyRevokeInputSchema>
