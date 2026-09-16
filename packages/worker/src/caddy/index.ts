export { CaddyClient } from './client'
export { CaddyRecoveryClient } from './recovery'

export { CaddyError, CaddyErrorCode, CaddyMutationOutcome, caddyErrorDetailsFromUnknown, isCaddyError } from './error'

export {
  CaddyCanonicalHostnameSchema,
  CaddyClientOptionsSchema,
  CaddyEndpointSchema,
  CaddyEtagSchema,
  CaddyExactMatcherSchema,
  CaddyExactPathSchema,
  CaddyExactRouteIdSchema,
  CaddyExactRouteSchema,
  CaddyFallbackRouteIdSchema,
  CaddyFallbackRouteSchema,
  CaddyHttpMethodListSchema,
  CaddyHttpMethodSchema,
  CaddyManagedRouteEntrySchema,
  CaddyManagedRouteIdSchema,
  CaddyManagedRouteSchema,
  CaddyPreviewMatcherSchema,
  CaddyPreviewRouteIdSchema,
  CaddyPreviewRouteSchema,
  CaddyRequestTimeoutMsSchema,
  CaddyRouteArraySchema,
  CaddyRoutesStateSchema,
  CaddyRecoveryBindingSchema,
  CaddyRecoveryStateSchema,
  CaddyServerNameSchema,
  CaddyStaticPrivateUpstreamSchema,
  DEFAULT_CADDY_REQUEST_TIMEOUT_MS,
} from './schema'

export type {
  CaddyClientOptions,
  CaddyConfigMutationMethod,
  CaddyExactRoute,
  CaddyHttpJsonResponse,
  CaddyHttpMutationResponse,
  CaddyManagedRoute,
  CaddyManagedRouteEntry,
  CaddyPreviewRoute,
  CaddyRoutesState,
  CaddyRecoveryBinding,
  CaddyRecoveryState,
  ResolvedCaddyClientOptions,
} from './types'
