import { z } from 'zod'
import { CapsuleActorReferenceSchema, type CapsuleActorReference } from '../actor'
import { CapsuleSnapshotLimitationsSchema } from '../snapshot/mode'

export const CAPSULE_ROUTE_EVIDENCE_SCHEMA_VERSION = 1 as const
export const CAPSULE_ROUTE_POLICY_VERSION = 1 as const

export const CapsuleRouteEvidenceDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, {
  message: "Route evidence digests must use the format 'sha256:<64 lowercase hex characters>'.",
})

export const CapsuleRouteEvidenceReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(value => !/[\u0000-\u001f\u007f]/.test(value), {
    message: 'Route evidence references cannot contain control characters.',
  })

export const CapsuleRouteEvidenceTimestampSchema = z.string().datetime({
  offset: true,
})

export const CapsuleRouteGoldenTestStatus = {
  PASSED: 'passed',
  NOT_RUN: 'not_run',
  WAIVED: 'waived',
} as const

export type CapsuleRouteGoldenTestStatus =
  (typeof CapsuleRouteGoldenTestStatus)[keyof typeof CapsuleRouteGoldenTestStatus]

export const CapsuleRouteGoldenTestStatusValues = [
  CapsuleRouteGoldenTestStatus.PASSED,
  CapsuleRouteGoldenTestStatus.NOT_RUN,
  CapsuleRouteGoldenTestStatus.WAIVED,
] as const

export const CapsuleRouteGoldenTestStatusSchema = z.enum(CapsuleRouteGoldenTestStatusValues)

export const CapsuleRouteDiffReviewStatus = {
  REVIEWED: 'reviewed',
  NOT_REVIEWED: 'not_reviewed',
  WAIVED: 'waived',
} as const

export type CapsuleRouteDiffReviewStatus =
  (typeof CapsuleRouteDiffReviewStatus)[keyof typeof CapsuleRouteDiffReviewStatus]

export const CapsuleRouteDiffReviewStatusValues = [
  CapsuleRouteDiffReviewStatus.REVIEWED,
  CapsuleRouteDiffReviewStatus.NOT_REVIEWED,
  CapsuleRouteDiffReviewStatus.WAIVED,
] as const

export const CapsuleRouteDiffReviewStatusSchema = z.enum(CapsuleRouteDiffReviewStatusValues)

export const CapsuleRouteWaiverSchema = z
  .object({
    actor: CapsuleActorReferenceSchema,
    reason: z.string().trim().min(1).max(2_000),
    waivedAt: CapsuleRouteEvidenceTimestampSchema,
  })
  .strict()

export const CapsuleRouteGoldenTestEvidenceSchema = z
  .object({
    status: CapsuleRouteGoldenTestStatusSchema,
    reference: CapsuleRouteEvidenceReferenceSchema.nullable(),
    waiver: CapsuleRouteWaiverSchema.nullable(),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.status === CapsuleRouteGoldenTestStatus.PASSED) {
      if (evidence.reference === null) {
        context.addIssue({
          code: 'custom',
          path: ['reference'],
          message: 'Passed golden-test evidence requires an immutable result reference.',
        })
      }
      if (evidence.waiver !== null) {
        context.addIssue({
          code: 'custom',
          path: ['waiver'],
          message: 'Passed golden-test evidence cannot contain a waiver.',
        })
      }
      return
    }
    if (evidence.status === CapsuleRouteGoldenTestStatus.WAIVED) {
      if (evidence.reference !== null) {
        context.addIssue({
          code: 'custom',
          path: ['reference'],
          message: 'Waived golden-test evidence cannot claim a passed result reference.',
        })
      }
      if (evidence.waiver === null) {
        context.addIssue({
          code: 'custom',
          path: ['waiver'],
          message: 'Waived golden-test evidence requires durable waiver evidence.',
        })
      }
      return
    }
    if (evidence.reference !== null || evidence.waiver !== null) {
      context.addIssue({
        code: 'custom',
        message: 'A golden test that was not run cannot contain passed or waiver evidence.',
      })
    }
  })

export const CapsuleRouteDiffReviewEvidenceSchema = z
  .object({
    status: CapsuleRouteDiffReviewStatusSchema,
    reference: CapsuleRouteEvidenceReferenceSchema.nullable(),
    waiver: CapsuleRouteWaiverSchema.nullable(),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.status === CapsuleRouteDiffReviewStatus.REVIEWED) {
      if (evidence.reference === null) {
        context.addIssue({
          code: 'custom',
          path: ['reference'],
          message: 'Completed diff review requires an immutable review reference.',
        })
      }
      if (evidence.waiver !== null) {
        context.addIssue({
          code: 'custom',
          path: ['waiver'],
          message: 'Completed diff review cannot contain a waiver.',
        })
      }
      return
    }
    if (evidence.status === CapsuleRouteDiffReviewStatus.WAIVED) {
      if (evidence.reference !== null) {
        context.addIssue({
          code: 'custom',
          path: ['reference'],
          message: 'Waived diff review cannot claim a completed review reference.',
        })
      }
      if (evidence.waiver === null) {
        context.addIssue({
          code: 'custom',
          path: ['waiver'],
          message: 'Waived diff review requires durable waiver evidence.',
        })
      }
      return
    }
    if (evidence.reference !== null || evidence.waiver !== null) {
      context.addIssue({
        code: 'custom',
        message: 'A diff that was not reviewed cannot contain completed or waiver evidence.',
      })
    }
  })

export const CapsuleRouteRiskEvidenceSchema = z
  .object({
    actor: CapsuleActorReferenceSchema,
    acknowledgedAt: CapsuleRouteEvidenceTimestampSchema,
    acceptedLimitations: CapsuleSnapshotLimitationsSchema,
  })
  .strict()

function actorIdentity(actor: CapsuleActorReference): string {
  return `${actor.type}\u0000${actor.id}`
}

function validateActorSet(
  actors: readonly CapsuleActorReference[],
  path: string,
  addIssue: (issue: { code: 'custom'; path: Array<string | number>; message: string }) => void,
): void {
  const identities = new Set<string>()
  actors.forEach((actor, index) => {
    const identity = actorIdentity(actor)
    if (identities.has(identity)) {
      addIssue({
        code: 'custom',
        path: [path, index],
        message: `Duplicate route evidence actor '${actor.type}:${actor.id}'.`,
      })
      return
    }
    identities.add(identity)
  })
}

/**
 * Immutable author, review, approval, test, and risk evidence attached to one
 * proposed route revision.
 *
 * This contract preserves evidence without deciding whether it satisfies an
 * exposure-specific promotion policy. Acceptance repositories will apply that
 * policy and independently validate actor separation.
 */
const CapsuleRouteEvidenceFieldsSchema = z
  .object({
    schemaVersion: z.literal(CAPSULE_ROUTE_EVIDENCE_SCHEMA_VERSION),
    policyVersion: z.literal(CAPSULE_ROUTE_POLICY_VERSION),
    authors: z.array(CapsuleActorReferenceSchema).min(1),
    reviewers: z.array(CapsuleActorReferenceSchema),
    approvers: z.array(CapsuleActorReferenceSchema),
    goldenTest: CapsuleRouteGoldenTestEvidenceSchema,
    diffReview: CapsuleRouteDiffReviewEvidenceSchema,
    risk: CapsuleRouteRiskEvidenceSchema,
  })
  .strict()

function validateEvidence(
  evidence: z.infer<typeof CapsuleRouteEvidenceFieldsSchema>,
  addIssue: (issue: { code: 'custom'; path: Array<string | number>; message: string }) => void,
): void {
  validateActorSet(evidence.authors, 'authors', addIssue)
  validateActorSet(evidence.reviewers, 'reviewers', addIssue)
  validateActorSet(evidence.approvers, 'approvers', addIssue)
}

export const CapsuleRouteEvidencePinBodySchema = CapsuleRouteEvidenceFieldsSchema.superRefine((evidence, context) => {
  validateEvidence(evidence, issue => {
    context.addIssue(issue)
  })
})

export const CapsuleRouteEvidencePinSchema = CapsuleRouteEvidenceFieldsSchema.extend({
  digest: CapsuleRouteEvidenceDigestSchema,
})
  .strict()
  .superRefine((evidence, context) => {
    validateEvidence(evidence, issue => {
      context.addIssue(issue)
    })
  })

export const CapsuleRouteEvidenceReferenceOutputSchema = z
  .object({
    schemaVersion: z.literal(CAPSULE_ROUTE_EVIDENCE_SCHEMA_VERSION),
    policyVersion: z.literal(CAPSULE_ROUTE_POLICY_VERSION),
    digest: CapsuleRouteEvidenceDigestSchema,
    goldenTestStatus: CapsuleRouteGoldenTestStatusSchema,
    diffReviewStatus: CapsuleRouteDiffReviewStatusSchema,
  })
  .strict()

export type CapsuleRouteEvidenceDigest = z.infer<typeof CapsuleRouteEvidenceDigestSchema>
export type CapsuleRouteWaiver = z.infer<typeof CapsuleRouteWaiverSchema>
export type CapsuleRouteGoldenTestEvidence = z.infer<typeof CapsuleRouteGoldenTestEvidenceSchema>
export type CapsuleRouteDiffReviewEvidence = z.infer<typeof CapsuleRouteDiffReviewEvidenceSchema>
export type CapsuleRouteRiskEvidence = z.infer<typeof CapsuleRouteRiskEvidenceSchema>
export type CapsuleRouteEvidencePinBody = z.infer<typeof CapsuleRouteEvidencePinBodySchema>
export type CapsuleRouteEvidencePin = z.infer<typeof CapsuleRouteEvidencePinSchema>
export type CapsuleRouteEvidenceReferenceOutput = z.infer<typeof CapsuleRouteEvidenceReferenceOutputSchema>
