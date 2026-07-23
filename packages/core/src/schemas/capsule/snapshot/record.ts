import { z } from 'zod'
import { CapsuleBranchNameSchema } from '../branch'
import { CapsuleBranchResourceInventoryDigestSchema } from '../resources'
import { CapsuleArtifactManifestReferenceSchema } from '../artifact/reference'
import { CapsuleSnapshotCapturePolicyReferenceSchema } from './policy'

export const CapsuleSnapshotTimestampSchema = z.string().datetime({
  offset: true,
})

/**
 * Client-safe committed snapshot summary.
 *
 * A returned row proves that Qiln committed the snapshot through its capture
 * operation and linked it to complete durable evidence. Detailed manifests, Git
 * records, dependencies, provider references, and diagnostics remain
 * server-side.
 */
export const CapsuleSnapshotSummarySchema = z
  .object({
    id: z.uuid(),
    capsuleId: z.uuid(),
    sourceBranchId: z.uuid(),
    sourceBranchName: CapsuleBranchNameSchema,
    sourceBranchResourceInventoryDigest: CapsuleBranchResourceInventoryDigestSchema,
    capturePolicy: CapsuleSnapshotCapturePolicyReferenceSchema,
    artifactManifest: CapsuleArtifactManifestReferenceSchema,
    createdAt: CapsuleSnapshotTimestampSchema,
    archivedAt: CapsuleSnapshotTimestampSchema.nullable(),
  })
  .strict()

export const CapsuleSnapshotListOutputSchema = z.array(CapsuleSnapshotSummarySchema)

export type CapsuleSnapshotTimestamp = z.infer<typeof CapsuleSnapshotTimestampSchema>
export type CapsuleSnapshotSummary = z.infer<typeof CapsuleSnapshotSummarySchema>
export type CapsuleSnapshotListOutput = z.infer<typeof CapsuleSnapshotListOutputSchema>
