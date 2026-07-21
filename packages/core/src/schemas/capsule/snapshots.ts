import { z } from 'zod'
import { CapsuleArtifactManifestReferenceSchema } from './artifact/reference'

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

export type CapsuleSnapshotSummary = z.infer<typeof CapsuleSnapshotSummarySchema>
export type CapsuleSnapshotListOutput = z.infer<typeof CapsuleSnapshotListOutputSchema>
