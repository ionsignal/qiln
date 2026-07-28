export { CaddyClient } from './client'

export { CaddyError, CaddyErrorCode, CaddyMutationOutcome, caddyErrorDetailsFromUnknown, isCaddyError } from './error'

export {
  CaddyAliasRouteEntrySchema,
  CaddyAliasRouteIdSchema,
  CaddyAliasRouteSchema,
  CaddyAliasesStateSchema,
  CaddyCanonicalHostnameSchema,
  CaddyClientOptionsSchema,
  CaddyEndpointSchema,
  CaddyEtagSchema,
  CaddyExactPathSchema,
  CaddyFallbackRouteIdSchema,
  CaddyFallbackRouteSchema,
  CaddyHttpMethodListSchema,
  CaddyHttpMethodSchema,
  CaddyRequestTimeoutMsSchema,
  CaddyServerNameSchema,
  CaddyStaticPrivateUpstreamSchema,
  DEFAULT_CADDY_REQUEST_TIMEOUT_MS,
} from './schema'

export type {
  CaddyAliasRoute,
  CaddyAliasRouteEntry,
  CaddyAliasesState,
  CaddyClientOptions,
  CaddyConfigMutationMethod,
  CaddyHttpJsonResponse,
  CaddyHttpMutationResponse,
  ResolvedCaddyClientOptions,
} from './types'
