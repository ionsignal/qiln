import { z } from 'zod'
import { isCanonicalAbsolutePosixPath } from '../../posix'

const ROUTE_ALIAS_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const ROUTE_HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

function isCanonicalRouteHost(value: string): boolean {
  if (value.length < 3 || value.length > 253 || value !== value.toLowerCase() || value.endsWith('.')) {
    return false
  }

  const labels = value.split('.')

  return labels.length >= 2 && labels.every(label => ROUTE_HOST_LABEL_PATTERN.test(label))
}

export const CapsuleRouteAliasNameSchema = z.string().min(1).max(63).regex(ROUTE_ALIAS_NAME_PATTERN, {
  message:
    'Route alias names must contain lowercase letters, digits, or internal hyphens and cannot start or end with a hyphen.',
})

export const CapsuleRouteExposure = {
  EXPERIMENTAL: 'experimental',
  PRODUCTION: 'production',
} as const

export type CapsuleRouteExposure = (typeof CapsuleRouteExposure)[keyof typeof CapsuleRouteExposure]
export const CapsuleRouteExposureValues = [CapsuleRouteExposure.EXPERIMENTAL, CapsuleRouteExposure.PRODUCTION] as const
export const CapsuleRouteExposureSchema = z.enum(CapsuleRouteExposureValues)

export const CapsuleRouteMethod = {
  DELETE: 'DELETE',
  GET: 'GET',
  HEAD: 'HEAD',
  OPTIONS: 'OPTIONS',
  PATCH: 'PATCH',
  POST: 'POST',
  PUT: 'PUT',
} as const

export type CapsuleRouteMethod = (typeof CapsuleRouteMethod)[keyof typeof CapsuleRouteMethod]

export const CapsuleRouteMethodValues = [
  CapsuleRouteMethod.DELETE,
  CapsuleRouteMethod.GET,
  CapsuleRouteMethod.HEAD,
  CapsuleRouteMethod.OPTIONS,
  CapsuleRouteMethod.PATCH,
  CapsuleRouteMethod.POST,
  CapsuleRouteMethod.PUT,
] as const

export const CapsuleRouteMethodSchema = z.enum(CapsuleRouteMethodValues)

export const CapsuleRouteHostSchema = z.string().refine(isCanonicalRouteHost, {
  message: 'Route hosts must be canonical lowercase DNS names with at least two labels and no trailing dot.',
})

export const CapsuleRoutePathSchema = z.string().refine(isCanonicalAbsolutePosixPath, {
  message: 'Route paths must be canonical absolute paths.',
})

export const CapsuleRouteMatcherDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, {
  message: "Route matcher digests must use the format 'sha256:<64 lowercase hex characters>'.",
})

/**
 * Exact MVP route matcher.
 *
 * Prefixes, wildcards, regular expressions, query matching, fragments, and
 * precedence rules are deliberately absent. Physical persistence additionally
 * reserves each exact host/path pair for one alias, preventing overlapping
 * method subsets from introducing ambiguous route ownership.
 */
export const CapsuleRouteMatcherSchema = z
  .object({
    host: CapsuleRouteHostSchema,
    path: CapsuleRoutePathSchema,
    methods: z.array(CapsuleRouteMethodSchema).min(1),
  })
  .strict()
  .superRefine((matcher, context) => {
    const methods = new Set<CapsuleRouteMethod>()

    matcher.methods.forEach((method, index) => {
      if (methods.has(method)) {
        context.addIssue({
          code: 'custom',
          path: ['methods', index],
          message: `Duplicate route method '${method}'.`,
        })
        return
      }

      methods.add(method)
    })
  })

export const CapsuleRouteMatcherPinSchema = CapsuleRouteMatcherSchema.extend({
  digest: CapsuleRouteMatcherDigestSchema,
}).strict()

export const CapsuleRouteAliasStatus = {
  INACTIVE: 'inactive',
  ACTIVE: 'active',
  MUTATING: 'mutating',
  CLEANUP_REQUIRED: 'cleanup_required',
  RETIRED: 'retired',
} as const

export type CapsuleRouteAliasStatus = (typeof CapsuleRouteAliasStatus)[keyof typeof CapsuleRouteAliasStatus]

export const CapsuleRouteAliasStatusValues = [
  CapsuleRouteAliasStatus.INACTIVE,
  CapsuleRouteAliasStatus.ACTIVE,
  CapsuleRouteAliasStatus.MUTATING,
  CapsuleRouteAliasStatus.CLEANUP_REQUIRED,
  CapsuleRouteAliasStatus.RETIRED,
] as const

export const CapsuleRouteAliasStatusSchema = z.enum(CapsuleRouteAliasStatusValues)

export type CapsuleRouteAliasName = z.infer<typeof CapsuleRouteAliasNameSchema>
export type CapsuleRouteHost = z.infer<typeof CapsuleRouteHostSchema>
export type CapsuleRoutePath = z.infer<typeof CapsuleRoutePathSchema>
export type CapsuleRouteMatcherDigest = z.infer<typeof CapsuleRouteMatcherDigestSchema>
export type CapsuleRouteMatcher = z.infer<typeof CapsuleRouteMatcherSchema>
export type CapsuleRouteMatcherPin = z.infer<typeof CapsuleRouteMatcherPinSchema>
