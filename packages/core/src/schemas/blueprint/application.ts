import { z } from 'zod'
import { isCanonicalAbsolutePosixPath } from '../posix'
import { CapsuleBlueprintIdentifierSchema } from './provision'

export const CapsuleBlueprintApplicationProtocol = {
  HTTP: 'http',
} as const

export type CapsuleBlueprintApplicationProtocol =
  (typeof CapsuleBlueprintApplicationProtocol)[keyof typeof CapsuleBlueprintApplicationProtocol]

export const CapsuleBlueprintApplicationProtocolValues = [CapsuleBlueprintApplicationProtocol.HTTP] as const
export const CapsuleBlueprintApplicationProtocolSchema = z.enum(CapsuleBlueprintApplicationProtocolValues)

export const CapsuleBlueprintApplicationExposure = {
  PROXY: 'proxy',
  INTERNAL: 'internal',
} as const

export type CapsuleBlueprintApplicationExposure =
  (typeof CapsuleBlueprintApplicationExposure)[keyof typeof CapsuleBlueprintApplicationExposure]

export const CapsuleBlueprintApplicationExposureValues = [
  CapsuleBlueprintApplicationExposure.PROXY,
  CapsuleBlueprintApplicationExposure.INTERNAL,
] as const

export const CapsuleBlueprintApplicationExposureSchema = z.enum(CapsuleBlueprintApplicationExposureValues)

export const CapsuleBlueprintEndpointContractMode = {
  PASSTHROUGH: 'passthrough',
} as const

export type CapsuleBlueprintEndpointContractMode =
  (typeof CapsuleBlueprintEndpointContractMode)[keyof typeof CapsuleBlueprintEndpointContractMode]

export const CapsuleBlueprintEndpointContractModeValues = [CapsuleBlueprintEndpointContractMode.PASSTHROUGH] as const
export const CapsuleBlueprintEndpointContractModeSchema = z.enum(CapsuleBlueprintEndpointContractModeValues)

export const CapsuleBlueprintVerificationMethod = {
  GET: 'GET',
  HEAD: 'HEAD',
} as const

export type CapsuleBlueprintVerificationMethod =
  (typeof CapsuleBlueprintVerificationMethod)[keyof typeof CapsuleBlueprintVerificationMethod]

export const CapsuleBlueprintVerificationMethodValues = [
  CapsuleBlueprintVerificationMethod.GET,
  CapsuleBlueprintVerificationMethod.HEAD,
] as const

export const CapsuleBlueprintVerificationMethodSchema = z.enum(CapsuleBlueprintVerificationMethodValues)

export const CapsuleBlueprintApplicationPathSchema = z.string().refine(isCanonicalAbsolutePosixPath, {
  message: 'Blueprint application paths must be canonical absolute POSIX paths.',
})

export const CapsuleBlueprintApplicationVerificationSchema = z
  .object({
    method: CapsuleBlueprintVerificationMethodSchema.default(CapsuleBlueprintVerificationMethod.GET),
    path: CapsuleBlueprintApplicationPathSchema,
    expected_statuses: z.array(z.number().int().min(100).max(599)).min(1),
  })
  .strict()
  .superRefine((verification, context) => {
    const statuses = new Set<number>()
    verification.expected_statuses.forEach((status, index) => {
      if (statuses.has(status)) {
        context.addIssue({
          code: 'custom',
          path: ['expected_statuses', index],
          message: `Duplicate application verification status '${status}'.`,
        })
        return
      }
      statuses.add(status)
    })
  })

/**
 * Immutable application-routing capability declared by a capsule Blueprint.
 *
 * This contract identifies the application endpoint Qiln may pin into a route
 * revision. It does not contain runtime addresses, route aliases, domains,
 * credentials, secret values, or Caddy configuration.
 *
 * The initial endpoint contract is deliberately passthrough-only. It identifies
 * an HTTP upstream and verification request without claiming typed request or
 * response payload semantics.
 */
export const CapsuleBlueprintApplicationSchema = z
  .object({
    name: CapsuleBlueprintIdentifierSchema,
    port: z.number().int().min(1).max(65535),
    protocol: z.literal(CapsuleBlueprintApplicationProtocol.HTTP),
    entrypoint: CapsuleBlueprintApplicationPathSchema,
    exposure: CapsuleBlueprintApplicationExposureSchema,
    endpoint: z
      .object({
        mode: z.literal(CapsuleBlueprintEndpointContractMode.PASSTHROUGH),
      })
      .strict(),
    verification: CapsuleBlueprintApplicationVerificationSchema,
  })
  .strict()

export type CapsuleBlueprintApplicationPath = z.infer<typeof CapsuleBlueprintApplicationPathSchema>
export type CapsuleBlueprintApplicationVerification = z.infer<typeof CapsuleBlueprintApplicationVerificationSchema>
export type CapsuleBlueprintApplication = z.infer<typeof CapsuleBlueprintApplicationSchema>
