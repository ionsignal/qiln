import { z } from 'zod'
import { parseCaddyAdminEndpoint } from '../endpoint'
import { isIP } from 'node:net'

export const DEFAULT_CADDY_REQUEST_TIMEOUT_MS = 15_000

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/
const CADDY_ROUTE_ID_PATTERN = /^qiln-route-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const CADDY_FALLBACK_ROUTE_ID_PATTERN = /^qiln-route-fallback-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const CADDY_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const HTTP_METHOD_TOKEN_PATTERN = /^[A-Z0-9!#$%&'*+.^_`|~-]+$/
const EXACT_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._~!$&'()+,;=:@-]+$/

function compareAscii(left: string, right: string): number {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

function isCanonicalHostname(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 253 ||
    value !== value.toLowerCase() ||
    value.endsWith('.') ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return false
  }
  const labels = value.split('.')
  return labels.every(label => label.length <= 63 && HOST_LABEL_PATTERN.test(label))
}

function isCanonicalExactPath(value: string): boolean {
  if (value === '/') {
    return true
  }
  if (!value.startsWith('/') || value.endsWith('/') || value.includes('//') || CONTROL_CHARACTER_PATTERN.test(value)) {
    return false
  }
  return value
    .slice(1)
    .split('/')
    .every(segment => segment !== '.' && segment !== '..' && EXACT_PATH_SEGMENT_PATTERN.test(segment))
}

function isCanonicalPort(value: string): boolean {
  if (!/^[1-9][0-9]{0,4}$/.test(value)) {
    return false
  }
  const port = Number(value)
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 && String(port) === value
}

function isPrivateIpv4(value: string): boolean {
  const segments = value.split('.')
  if (segments.length !== 4) {
    return false
  }
  const octets: number[] = []
  for (const segment of segments) {
    if (!/^[0-9]{1,3}$/.test(segment)) {
      return false
    }
    const octet = Number(segment)
    if (!Number.isSafeInteger(octet) || octet < 0 || octet > 255 || String(octet) !== segment) {
      return false
    }
    octets.push(octet)
  }
  const [first, second] = octets
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)
}

function isPrivateIpv6(value: string): boolean {
  return value === value.toLowerCase() && isIP(value) === 6 && (value.startsWith('fc') || value.startsWith('fd'))
}

function isCanonicalPrivateDial(value: string): boolean {
  const ipv4Match = /^([0-9.]+):([0-9]+)$/.exec(value)
  if (ipv4Match) {
    return isPrivateIpv4(ipv4Match[1]) && isCanonicalPort(ipv4Match[2])
  }

  const ipv6Match = /^\[([0-9a-f:]+)\]:([0-9]+)$/.exec(value)
  if (ipv6Match) {
    return isPrivateIpv6(ipv6Match[1]) && isCanonicalPort(ipv6Match[2])
  }

  return false
}

export const CaddyEndpointSchema = z.string().superRefine((value, context) => {
  try {
    parseCaddyAdminEndpoint(value)
  } catch (error: unknown) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : 'Invalid Caddy admin endpoint.',
    })
  }
})

export const CaddyServerNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(CADDY_SERVER_NAME_PATTERN, 'Caddy server name contains unsupported characters.')

const CaddyManagedRouteIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(CADDY_ROUTE_ID_PATTERN, 'Caddy route ID must use the Qiln-managed route namespace.')

export const CaddyAliasRouteIdSchema = CaddyManagedRouteIdSchema.refine(
  value => !value.startsWith('qiln-route-fallback-'),
  'Caddy alias route ID cannot use the reserved fallback route namespace.',
)

export const CaddyFallbackRouteIdSchema = CaddyManagedRouteIdSchema.refine(
  value => CADDY_FALLBACK_ROUTE_ID_PATTERN.test(value),
  'Caddy fallback route ID must use the reserved Qiln fallback route namespace.',
)

export const CaddyEtagSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    value => value.trim() !== '' && !CONTROL_CHARACTER_PATTERN.test(value),
    'Caddy ETag must be a non-empty HTTP header value.',
  )

export const CaddyRequestTimeoutMsSchema = z
  .number()
  .int()
  .positive()
  .max(120_000, 'Caddy request timeout cannot exceed 120 seconds.')

export const CaddyCanonicalHostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .refine(
    isCanonicalHostname,
    'Caddy route hostname must be lowercase, canonical, and free of wildcard or placeholder syntax.',
  )

export const CaddyExactPathSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    isCanonicalExactPath,
    'Caddy route path must be a canonical exact absolute path without wildcards, encodings, or traversal segments.',
  )

export const CaddyHttpMethodSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(HTTP_METHOD_TOKEN_PATTERN, 'Caddy route method must be an uppercase HTTP token.')

export const CaddyHttpMethodListSchema = z
  .array(CaddyHttpMethodSchema)
  .min(1)
  .max(16)
  .superRefine((methods, context) => {
    const uniqueMethods = new Set(methods)
    if (uniqueMethods.size !== methods.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Caddy route methods must be unique.',
      })
    }
    const sortedMethods = [...methods].sort(compareAscii)
    if (methods.some((method, index) => method !== sortedMethods[index])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Caddy route methods must be sorted in ASCII order.',
      })
    }
  })

export const CaddyStaticPrivateUpstreamSchema = z
  .object({
    dial: z
      .string()
      .min(1)
      .max(128)
      .refine(
        isCanonicalPrivateDial,
        'Caddy upstream dial target must be one canonical RFC1918 IPv4 or ULA IPv6 address with one TCP port.',
      ),
  })
  .strict()

export const CaddyAliasMatcherSchema = z
  .object({
    host: z.tuple([CaddyCanonicalHostnameSchema]),
    path: z.tuple([CaddyExactPathSchema]),
    method: CaddyHttpMethodListSchema,
  })
  .strict()

export const CaddyReverseProxyHandlerSchema = z
  .object({
    handler: z.literal('reverse_proxy'),
    upstreams: z.tuple([CaddyStaticPrivateUpstreamSchema]),
  })
  .strict()

/**
 * Qiln intentionally emits only this native Caddy JSON shape for one stable
 * alias. Excluding optional Caddy fields prevents this client from becoming a
 * generic route editor.
 */
export const CaddyAliasRouteSchema = z
  .object({
    '@id': CaddyAliasRouteIdSchema,
    match: z.tuple([CaddyAliasMatcherSchema]),
    handle: z.tuple([CaddyReverseProxyHandlerSchema]),
    terminal: z.literal(true),
  })
  .strict()

export const CaddyStaticNotFoundHandlerSchema = z
  .object({
    handler: z.literal('static_response'),
    status_code: z.literal(404),
  })
  .strict()

/**
 * Infrastructure must create this exact fallback shape before the Worker is
 * allowed to inspect or mutate the managed route array.
 */
export const CaddyFallbackRouteSchema = z
  .object({
    '@id': CaddyFallbackRouteIdSchema,
    handle: z.tuple([CaddyStaticNotFoundHandlerSchema]),
    terminal: z.literal(true),
  })
  .strict()

export const CaddyRouteArraySchema = z.array(z.unknown()).min(1)

export const CaddyAliasRouteEntrySchema = z
  .object({
    id: CaddyAliasRouteIdSchema,
    index: z.int().nonnegative(),
    route: CaddyAliasRouteSchema,
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.id !== entry.route['@id']) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['id'],
        message: 'Caddy alias state ID must match the route @id.',
      })
    }
  })

export const CaddyAliasesStateSchema = z
  .object({
    etag: CaddyEtagSchema,
    aliases: z.array(CaddyAliasRouteEntrySchema),
  })
  .strict()
  .superRefine((state, context) => {
    const ids = new Set<string>()
    for (const [position, alias] of state.aliases.entries()) {
      if (alias.index !== position) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['aliases', position, 'index'],
          message: 'Caddy alias state indexes must be contiguous and ordered before the fallback route.',
        })
      }
      if (ids.has(alias.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['aliases', position, 'id'],
          message: 'Caddy alias state cannot contain duplicate route IDs.',
        })
      }
      ids.add(alias.id)
    }
  })

export const CaddyClientOptionsSchema = z
  .object({
    endpoint: CaddyEndpointSchema,
    server: CaddyServerNameSchema,
    fallbackId: CaddyFallbackRouteIdSchema,
    timeoutMs: CaddyRequestTimeoutMsSchema.default(DEFAULT_CADDY_REQUEST_TIMEOUT_MS),
  })
  .strict()
