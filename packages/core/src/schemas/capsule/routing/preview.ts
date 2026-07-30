import { z } from 'zod'
import { CapsuleBlueprintIdentifierSchema } from '../../blueprint/provision'
import { CapsuleRouteHostSchema } from './alias'
import { CapsuleRouteEvidenceTimestampSchema } from './evidence'
import { CapsuleRouteApplicationPinSchema } from './target'

export const CapsuleBranchPreviewStatus = {
  INACTIVE: 'inactive',
  APPLYING: 'applying',
  VERIFYING: 'verifying',
  ACTIVE: 'active',
  DEGRADED: 'degraded',
  REMOVING: 'removing',
  CLEANUP_REQUIRED: 'cleanup_required',
} as const

export type CapsuleBranchPreviewStatus = (typeof CapsuleBranchPreviewStatus)[keyof typeof CapsuleBranchPreviewStatus]

export const CapsuleBranchPreviewStatusValues = [
  CapsuleBranchPreviewStatus.INACTIVE,
  CapsuleBranchPreviewStatus.APPLYING,
  CapsuleBranchPreviewStatus.VERIFYING,
  CapsuleBranchPreviewStatus.ACTIVE,
  CapsuleBranchPreviewStatus.DEGRADED,
  CapsuleBranchPreviewStatus.REMOVING,
  CapsuleBranchPreviewStatus.CLEANUP_REQUIRED,
] as const

export const CapsuleBranchPreviewStatusSchema = z.enum(CapsuleBranchPreviewStatusValues)

export const CapsuleBranchPreviewRouteIdSchema = z
  .string()
  .min(14)
  .max(128)
  .regex(
    /^qiln-preview-[a-z0-9](?:[a-z0-9-]{0,113}[a-z0-9])?$/,
    'Preview route IDs must use the Qiln-managed preview route namespace.',
  )

export const CapsuleBranchPreviewRuntimeIpSchema = z.string().trim().min(1).max(255)

export const CapsuleBranchPreviewSummarySchema = z
  .object({
    id: z.uuid(),
    capsuleId: z.uuid(),
    branchId: z.uuid(),
    applicationName: CapsuleBlueprintIdentifierSchema,
    host: CapsuleRouteHostSchema,
    status: CapsuleBranchPreviewStatusSchema,
    application: CapsuleRouteApplicationPinSchema,
    verifiedAt: CapsuleRouteEvidenceTimestampSchema.nullable(),
    createdAt: CapsuleRouteEvidenceTimestampSchema,
    updatedAt: CapsuleRouteEvidenceTimestampSchema,
  })
  .strict()

export const CapsuleBranchPreviewListOutputSchema = z.array(CapsuleBranchPreviewSummarySchema)

export type CapsuleBranchPreviewRouteId = z.infer<typeof CapsuleBranchPreviewRouteIdSchema>
export type CapsuleBranchPreviewRuntimeIp = z.infer<typeof CapsuleBranchPreviewRuntimeIpSchema>
export type CapsuleBranchPreviewSummary = z.infer<typeof CapsuleBranchPreviewSummarySchema>
export type CapsuleBranchPreviewListOutput = z.infer<typeof CapsuleBranchPreviewListOutputSchema>
