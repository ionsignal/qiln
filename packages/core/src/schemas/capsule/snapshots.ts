import { z } from 'zod'

/**
 * A reviewed blueprint digest and an immutable artifact-manifest digest have
 * identical cryptographic formatting but make different product claims. Keeping
 * this distinct schema prevents bootstrap provenance from being conflated with
 * a future captured capsule snapshot manifest.
 */
export const CapsuleArtifactManifestDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, {
  message: "Capsule artifact manifest digests must use the format 'sha256:<64 lowercase hex characters>'.",
})

/**
 * Immutable reference to the canonical artifact manifest captured for a future
 * capsule snapshot. The physical artifact collection and snapshot writer are
 * intentionally outside this contract-only PR.
 */
export const CapsuleArtifactManifestReferenceSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    digest: CapsuleArtifactManifestDigestSchema,
  })
  .strict()

const CapsuleSnapshotTimestampSchema = z.string().datetime({
  offset: true,
})

/**
 * Client-safe immutable snapshot record summary.
 *
 * A snapshot represents committed audit history. `archivedAt` therefore remains
 * visible rather than filtering archived snapshot records from list responses.
 */
export const CapsuleSnapshotSummarySchema = z
  .object({
    id: z.uuid(),
    capsuleId: z.uuid(),
    sourceBranchId: z.uuid(),
    artifactManifest: CapsuleArtifactManifestReferenceSchema,
    createdAt: CapsuleSnapshotTimestampSchema,
    archivedAt: CapsuleSnapshotTimestampSchema.nullable(),
  })
  .strict()

export const CapsuleSnapshotListOutputSchema = z.array(CapsuleSnapshotSummarySchema)

export type CapsuleArtifactManifestDigest = z.infer<typeof CapsuleArtifactManifestDigestSchema>
export type CapsuleArtifactManifestReference = z.infer<typeof CapsuleArtifactManifestReferenceSchema>
export type CapsuleSnapshotSummary = z.infer<typeof CapsuleSnapshotSummarySchema>
export type CapsuleSnapshotListOutput = z.infer<typeof CapsuleSnapshotListOutputSchema>
