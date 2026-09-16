import { z } from 'zod'
import { CapsuleBlueprintReferenceSchema } from '../../blueprint/catalog'
import { CapsuleBranchNameSchema } from '../branch'
import { CapsuleBranchResourceInventoryDigestSchema } from '../resources'

export const CapsuleSnapshotTimestampSchema = z.string().datetime({
  offset: true,
})

/**
 * Withdrawal of restoration availability, not proof of physical deletion.
 *
 * The retiring operation retains independent provider-deletion accounting.
 * Consumers must not treat a retired snapshot as an eligible fork source.
 */
export const CapsuleSnapshotRetirementSchema = z
  .object({
    operationId: z.uuid(),
    retiredAt: CapsuleSnapshotTimestampSchema,
  })
  .strict()

/**
 * Client-safe committed snapshot summary.
 *
 * A returned row proves that Qiln committed the snapshot through Create
 * Snapshot and retained the restoration evidence needed to fork an editable
 * branch. Provider references, Blueprint pins, and diagnostics remain
 * server-side.
 *
 * A snapshot does not claim to preserve mutable rootfs changes, external bind
 * mount contents, application correctness, Git history, file-level contents, or
 * a detailed change report.
 */
export const CapsuleSnapshotSummarySchema = z
  .object({
    id: z.uuid(),
    capsuleId: z.uuid(),
    sourceBranchId: z.uuid(),
    sourceBranchName: CapsuleBranchNameSchema,
    sourceBranchResourceInventoryDigest: CapsuleBranchResourceInventoryDigestSchema,
    blueprint: CapsuleBlueprintReferenceSchema,
    createdAt: CapsuleSnapshotTimestampSchema,
  })
  .strict()

export const CapsuleSnapshotListOutputSchema = z.array(CapsuleSnapshotSummarySchema)

export type CapsuleSnapshotTimestamp = z.infer<typeof CapsuleSnapshotTimestampSchema>
export type CapsuleSnapshotRetirement = z.infer<typeof CapsuleSnapshotRetirementSchema>
export type CapsuleSnapshotSummary = z.infer<typeof CapsuleSnapshotSummarySchema>
export type CapsuleSnapshotListOutput = z.infer<typeof CapsuleSnapshotListOutputSchema>
