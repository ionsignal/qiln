import { z } from 'zod'
import { CapsuleArtifactManifestReferenceSchema } from '../artifact/reference'
import { CapsuleBranchNameSchema } from '../branch'
import { CapsuleBranchResourceInventoryDigestSchema } from '../resources'
import { CapsuleSnapshotLimitationsSchema, CapsuleSnapshotMode, CapsuleSnapshotModeSchema } from './mode'
import { CapsuleSnapshotCapturePolicyReferenceSchema } from './policy'

export const CapsuleSnapshotTimestampSchema = z.string().datetime({
  offset: true,
})

/**
 * Client-safe committed snapshot summary.
 *
 * A returned row proves that Qiln committed the snapshot through its capture
 * operation and linked it to durable evidence. Detailed manifests, Git records,
 * dependencies, provider references, and diagnostics remain server-side.
 *
 * Experimental snapshots are deliberately non-fork-ready even though they are
 * committed and visible when explicitly requested.
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
    mode: CapsuleSnapshotModeSchema,
    forkReady: z.literal(false),
    limitations: CapsuleSnapshotLimitationsSchema,
    createdAt: CapsuleSnapshotTimestampSchema,
    archivedAt: CapsuleSnapshotTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.mode === CapsuleSnapshotMode.EXPERIMENTAL && snapshot.forkReady !== false) {
      context.addIssue({
        code: 'custom',
        path: ['forkReady'],
        message: 'Experimental capsule snapshots cannot be fork-ready.',
      })
    }
  })

export const CapsuleSnapshotListOutputSchema = z.array(CapsuleSnapshotSummarySchema)

export type CapsuleSnapshotTimestamp = z.infer<typeof CapsuleSnapshotTimestampSchema>
export type CapsuleSnapshotSummary = z.infer<typeof CapsuleSnapshotSummarySchema>
export type CapsuleSnapshotListOutput = z.infer<typeof CapsuleSnapshotListOutputSchema>
