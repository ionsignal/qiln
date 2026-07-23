import { z } from 'zod'

/**
 * Snapshot modes describe the strength of evidence committed with capsule
 * history.
 *
 * The initial experimental mode deliberately makes no fork, restoration,
 * promotion, or rollback claim.
 */
export const CapsuleSnapshotMode = {
  EXPERIMENTAL: 'experimental',
} as const

export type CapsuleSnapshotModeValue = (typeof CapsuleSnapshotMode)[keyof typeof CapsuleSnapshotMode]

export const CapsuleSnapshotModeValues = [CapsuleSnapshotMode.EXPERIMENTAL] as const
export const CapsuleSnapshotModeSchema = z.enum(CapsuleSnapshotModeValues)

export const CapsuleSnapshotLimitation = {
  GIT_EVIDENCE_OMITTED: 'git_evidence_omitted',
  DEPENDENCY_EVIDENCE_OMITTED: 'dependency_evidence_omitted',
  SOURCE_VOLUME_COLLECTION: 'source_volume_collection',
  SECRET_POLICY_UNVERIFIED: 'secret_policy_unverified',
} as const

export type CapsuleSnapshotLimitationValue = (typeof CapsuleSnapshotLimitation)[keyof typeof CapsuleSnapshotLimitation]

export const CapsuleSnapshotLimitationValues = [
  CapsuleSnapshotLimitation.GIT_EVIDENCE_OMITTED,
  CapsuleSnapshotLimitation.DEPENDENCY_EVIDENCE_OMITTED,
  CapsuleSnapshotLimitation.SOURCE_VOLUME_COLLECTION,
  CapsuleSnapshotLimitation.SECRET_POLICY_UNVERIFIED,
] as const

export const CapsuleSnapshotLimitationSchema = z.enum(CapsuleSnapshotLimitationValues)

export const CapsuleSnapshotLimitationsSchema = z
  .array(CapsuleSnapshotLimitationSchema)
  .min(1)
  .superRefine((limitations, context) => {
    const seen = new Set<CapsuleSnapshotLimitationValue>()

    limitations.forEach((limitation, index) => {
      if (seen.has(limitation)) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: `Duplicate capsule snapshot limitation '${limitation}'.`,
        })
        return
      }

      seen.add(limitation)
    })
  })

/**
 * The complete limitation set committed by the first experimental collector.
 *
 * This value is Worker-owned. It must never be accepted from browser input.
 */
export const ExperimentalCapsuleSnapshotLimitations = [
  CapsuleSnapshotLimitation.GIT_EVIDENCE_OMITTED,
  CapsuleSnapshotLimitation.DEPENDENCY_EVIDENCE_OMITTED,
  CapsuleSnapshotLimitation.SOURCE_VOLUME_COLLECTION,
  CapsuleSnapshotLimitation.SECRET_POLICY_UNVERIFIED,
] as const satisfies readonly CapsuleSnapshotLimitationValue[]

export type CapsuleSnapshotLimitations = z.infer<typeof CapsuleSnapshotLimitationsSchema>
