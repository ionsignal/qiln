import { z } from 'zod'
import { CapsuleBlueprintReferenceSchema } from '../../blueprint/catalog'
import { CapsuleArtifactManifestReferenceSchema } from '../artifact/reference'
import { CapsuleBranchNameSchema } from '../branch'
import { CapsuleBranchResourceInventoryDigestSchema } from '../resources'
import { CapsuleSnapshotAssuranceSchema } from './mode'
import { CapsuleSnapshotCapturePolicyReferenceSchema } from './policy'

export const CapsuleSnapshotTimestampSchema = z.string().datetime({
  offset: true,
})

/**
 * Client-safe committed snapshot summary.
 *
 * A returned row proves that Qiln committed the snapshot through its capture
 * operation and linked it to durable evidence. Detailed manifests, Git records,
 * dependencies, provider references, Blueprint pins, and diagnostics remain
 * server-side.
 *
 * Snapshot eligibility is represented by assurance mode and explicit
 * limitations rather than a provisional fork-readiness boolean.
 */
export const CapsuleSnapshotSummarySchema = z
  .object({
    id: z.uuid(),
    capsuleId: z.uuid(),
    sourceBranchId: z.uuid(),
    sourceBranchName: CapsuleBranchNameSchema,
    sourceBranchResourceInventoryDigest: CapsuleBranchResourceInventoryDigestSchema,
    blueprint: CapsuleBlueprintReferenceSchema,
    capturePolicy: CapsuleSnapshotCapturePolicyReferenceSchema,
    artifactManifest: CapsuleArtifactManifestReferenceSchema,
    assurance: CapsuleSnapshotAssuranceSchema,
    createdAt: CapsuleSnapshotTimestampSchema,
    archivedAt: CapsuleSnapshotTimestampSchema.nullable(),
  })
  .strict()

export const CapsuleSnapshotListOutputSchema = z.array(CapsuleSnapshotSummarySchema)

export type CapsuleSnapshotTimestamp = z.infer<typeof CapsuleSnapshotTimestampSchema>
export type CapsuleSnapshotSummary = z.infer<typeof CapsuleSnapshotSummarySchema>
export type CapsuleSnapshotListOutput = z.infer<typeof CapsuleSnapshotListOutputSchema>
