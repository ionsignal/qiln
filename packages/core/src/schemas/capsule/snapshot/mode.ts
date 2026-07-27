import { z } from 'zod'

/**
 * Snapshot modes describe the strength of evidence committed with capsule
 * history.
 *
 * Experimental snapshots may support explicitly experimental forks and route
 * aliases while retaining limitations. Hardened snapshots are reserved for a
 * future writer that proves complete restoration and production-routing
 * requirements.
 */
export const CapsuleSnapshotMode = {
  EXPERIMENTAL: 'experimental',
  HARDENED: 'hardened',
} as const

export type CapsuleSnapshotModeValue = (typeof CapsuleSnapshotMode)[keyof typeof CapsuleSnapshotMode]

export const CapsuleSnapshotModeValues = [CapsuleSnapshotMode.EXPERIMENTAL, CapsuleSnapshotMode.HARDENED] as const

export const CapsuleSnapshotModeSchema = z.enum(CapsuleSnapshotModeValues)

export const CapsuleSnapshotLimitation = {
  GIT_EVIDENCE_OMITTED: 'git_evidence_omitted',
  DEPENDENCY_EVIDENCE_OMITTED: 'dependency_evidence_omitted',
  SECRET_POLICY_UNVERIFIED: 'secret_policy_unverified',
} as const

export type CapsuleSnapshotLimitationValue = (typeof CapsuleSnapshotLimitation)[keyof typeof CapsuleSnapshotLimitation]

export const CapsuleSnapshotLimitationValues = [
  CapsuleSnapshotLimitation.GIT_EVIDENCE_OMITTED,
  CapsuleSnapshotLimitation.DEPENDENCY_EVIDENCE_OMITTED,
  CapsuleSnapshotLimitation.SECRET_POLICY_UNVERIFIED,
] as const

export const CapsuleSnapshotLimitationSchema = z.enum(CapsuleSnapshotLimitationValues)

export const CapsuleSnapshotLimitationsSchema = z
  .array(CapsuleSnapshotLimitationSchema)
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

export const CapsuleSnapshotAssuranceSchema = z
  .object({
    mode: CapsuleSnapshotModeSchema,
    limitations: CapsuleSnapshotLimitationsSchema,
  })
  .strict()
  .superRefine((assurance, context) => {
    if (assurance.mode === CapsuleSnapshotMode.EXPERIMENTAL && assurance.limitations.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['limitations'],
        message: 'Experimental capsule snapshots must disclose at least one assurance limitation.',
      })
    }

    if (assurance.mode === CapsuleSnapshotMode.HARDENED && assurance.limitations.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['limitations'],
        message: 'Hardened capsule snapshots cannot retain experimental assurance limitations.',
      })
    }
  })

/**
 * The complete limitation set committed by the current experimental collector.
 *
 * This value is Worker-owned. It must never be accepted from browser input.
 */
export const ExperimentalCapsuleSnapshotLimitations = [
  CapsuleSnapshotLimitation.GIT_EVIDENCE_OMITTED,
  CapsuleSnapshotLimitation.DEPENDENCY_EVIDENCE_OMITTED,
  CapsuleSnapshotLimitation.SECRET_POLICY_UNVERIFIED,
] as const satisfies readonly CapsuleSnapshotLimitationValue[]

export type CapsuleSnapshotLimitations = z.infer<typeof CapsuleSnapshotLimitationsSchema>
export type CapsuleSnapshotAssurance = z.infer<typeof CapsuleSnapshotAssuranceSchema>
