import { z } from 'zod'

export const CapsuleRouteProvider = {
  CADDY: 'caddy',
} as const

export type CapsuleRouteProvider = (typeof CapsuleRouteProvider)[keyof typeof CapsuleRouteProvider]

export const CapsuleRouteProviderValues = [CapsuleRouteProvider.CADDY] as const

export const CapsuleRouteProviderSchema = z.enum(CapsuleRouteProviderValues)

export const CapsuleRouteProviderStatus = {
  PLANNED: 'planned',
  APPLYING: 'applying',
  APPLIED: 'applied',
  VERIFYING: 'verifying',
  VERIFIED: 'verified',
  FAILED: 'failed',
  CLEANUP_REQUIRED: 'cleanup_required',
} as const

export type CapsuleRouteProviderStatus = (typeof CapsuleRouteProviderStatus)[keyof typeof CapsuleRouteProviderStatus]

export const CapsuleRouteProviderStatusValues = [
  CapsuleRouteProviderStatus.PLANNED,
  CapsuleRouteProviderStatus.APPLYING,
  CapsuleRouteProviderStatus.APPLIED,
  CapsuleRouteProviderStatus.VERIFYING,
  CapsuleRouteProviderStatus.VERIFIED,
  CapsuleRouteProviderStatus.FAILED,
  CapsuleRouteProviderStatus.CLEANUP_REQUIRED,
] as const

export const CapsuleRouteProviderStatusSchema = z.enum(CapsuleRouteProviderStatusValues)

export const CapsuleRouteConfigurationDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, {
  message: "Route provider configuration digests must use the format 'sha256:<64 lowercase hex characters>'.",
})

export const CapsuleRouteConfigurationKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(value => !/[\u0000-\u001f\u007f]/.test(value), {
    message: 'Route provider configuration keys cannot contain control characters.',
  })

export const CapsuleRouteVerificationEvidenceSchema = z
  .object({
    configurationDigest: CapsuleRouteConfigurationDigestSchema,
    upstreamVerified: z.boolean(),
    routeVerified: z.boolean(),
    verifiedAt: z.string().datetime({
      offset: true,
    }),
  })
  .strict()

export type CapsuleRouteConfigurationDigest = z.infer<typeof CapsuleRouteConfigurationDigestSchema>
export type CapsuleRouteConfigurationKey = z.infer<typeof CapsuleRouteConfigurationKeySchema>
export type CapsuleRouteVerificationEvidence = z.infer<typeof CapsuleRouteVerificationEvidenceSchema>
