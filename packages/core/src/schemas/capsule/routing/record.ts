import { z } from 'zod'
import { CapsuleRouteAliasNameSchema, CapsuleRouteAliasStatusSchema, CapsuleRouteExposureSchema } from './alias'
import { CapsuleRouteEvidenceReferenceOutputSchema, CapsuleRouteEvidenceTimestampSchema } from './evidence'
import { CapsuleRouteMatcherPinSchema } from './alias'
import { CapsuleRouteRevisionActionSchema } from './revision'
import { CapsuleRouteTargetReferenceSchema } from './target'

export const CapsuleRouteRevisionSummarySchema = z
  .object({
    id: z.uuid(),
    number: z.number().int().positive(),
    action: CapsuleRouteRevisionActionSchema,
    previousRevisionId: z.uuid().nullable(),
    rollbackSourceRevisionId: z.uuid().nullable(),
    target: CapsuleRouteTargetReferenceSchema,
    evidence: CapsuleRouteEvidenceReferenceOutputSchema,
    operationId: z.uuid(),
    committedAt: CapsuleRouteEvidenceTimestampSchema,
  })
  .strict()

/**
 * Client-safe committed route state.
 *
 * Proposed revisions and provider diagnostics are intentionally absent. A null
 * current revision means the alias has no committed route target.
 */
export const CapsuleRouteAliasSummarySchema = z
  .object({
    id: z.uuid(),
    capsuleId: z.uuid(),
    name: CapsuleRouteAliasNameSchema,
    exposure: CapsuleRouteExposureSchema,
    matcher: CapsuleRouteMatcherPinSchema,
    status: CapsuleRouteAliasStatusSchema,
    current: CapsuleRouteRevisionSummarySchema.nullable(),
    createdAt: CapsuleRouteEvidenceTimestampSchema,
    updatedAt: CapsuleRouteEvidenceTimestampSchema,
  })
  .strict()

export const CapsuleRouteAliasListOutputSchema = z.array(CapsuleRouteAliasSummarySchema)

export type CapsuleRouteRevisionSummary = z.infer<typeof CapsuleRouteRevisionSummarySchema>
export type CapsuleRouteAliasSummary = z.infer<typeof CapsuleRouteAliasSummarySchema>
export type CapsuleRouteAliasListOutput = z.infer<typeof CapsuleRouteAliasListOutputSchema>
