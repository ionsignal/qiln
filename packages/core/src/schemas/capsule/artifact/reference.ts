import { z } from 'zod'
import { CapsuleArtifactManifestSchemaVersionSchema } from './manifest'

/**
 * A blueprint digest and an artifact-manifest digest share cryptographic
 * formatting but make different domain claims.
 */
export const CapsuleArtifactManifestDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, {
  message: "Capsule artifact manifest digests must use the format 'sha256:<64 lowercase hex characters>'.",
})

/**
 * Client-safe immutable reference to a canonical artifact manifest.
 *
 * The reference alone does not claim that a committed capsule snapshot or all
 * required physical provider snapshots exist.
 */
export const CapsuleArtifactManifestReferenceSchema = z
  .object({
    schemaVersion: CapsuleArtifactManifestSchemaVersionSchema,
    digest: CapsuleArtifactManifestDigestSchema,
  })
  .strict()

export type CapsuleArtifactManifestDigest = z.infer<typeof CapsuleArtifactManifestDigestSchema>
export type CapsuleArtifactManifestReference = z.infer<typeof CapsuleArtifactManifestReferenceSchema>
