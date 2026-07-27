import { z } from 'zod'
import { CapsuleRouteEvidencePinSchema } from './evidence'
import { CapsuleRouteTargetPinSchema } from './target'

export const CapsuleRouteRevisionAction = {
  PROMOTE: 'promote',
  ROLLBACK: 'rollback',
} as const

export type CapsuleRouteRevisionAction = (typeof CapsuleRouteRevisionAction)[keyof typeof CapsuleRouteRevisionAction]

export const CapsuleRouteRevisionActionValues = [
  CapsuleRouteRevisionAction.PROMOTE,
  CapsuleRouteRevisionAction.ROLLBACK,
] as const

export const CapsuleRouteRevisionActionSchema = z.enum(CapsuleRouteRevisionActionValues)

export const CapsuleRouteRevisionStatus = {
  PROPOSED: 'proposed',
  COMMITTED: 'committed',
  FAILED: 'failed',
  CLEANUP_REQUIRED: 'cleanup_required',
} as const

export type CapsuleRouteRevisionStatus = (typeof CapsuleRouteRevisionStatus)[keyof typeof CapsuleRouteRevisionStatus]

export const CapsuleRouteRevisionStatusValues = [
  CapsuleRouteRevisionStatus.PROPOSED,
  CapsuleRouteRevisionStatus.COMMITTED,
  CapsuleRouteRevisionStatus.FAILED,
  CapsuleRouteRevisionStatus.CLEANUP_REQUIRED,
] as const

export const CapsuleRouteRevisionStatusSchema = z.enum(CapsuleRouteRevisionStatusValues)

/**
 * Immutable revision content accepted with a promote or rollback operation.
 *
 * A rollback creates a new revision targeting the historical revision selected
 * by `rollbackSourceRevisionId`; it never rewrites or reactivates that row.
 */
export const CapsuleRouteRevisionProposalSchema = z
  .object({
    action: CapsuleRouteRevisionActionSchema,
    previousRevisionId: z.uuid().nullable(),
    rollbackSourceRevisionId: z.uuid().nullable(),
    target: CapsuleRouteTargetPinSchema,
    evidence: CapsuleRouteEvidencePinSchema,
  })
  .strict()
  .superRefine((proposal, context) => {
    if (proposal.action === CapsuleRouteRevisionAction.PROMOTE && proposal.rollbackSourceRevisionId !== null) {
      context.addIssue({
        code: 'custom',
        path: ['rollbackSourceRevisionId'],
        message: 'Promotion revisions cannot identify a rollback source revision.',
      })
    }
    if (proposal.action === CapsuleRouteRevisionAction.ROLLBACK && proposal.rollbackSourceRevisionId === null) {
      context.addIssue({
        code: 'custom',
        path: ['rollbackSourceRevisionId'],
        message: 'Rollback revisions must identify a previously committed source revision.',
      })
    }
  })

export type CapsuleRouteRevisionProposal = z.infer<typeof CapsuleRouteRevisionProposalSchema>
