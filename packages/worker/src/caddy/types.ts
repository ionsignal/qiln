import type { input, output } from 'zod'
import type {
  CaddyClientOptionsSchema,
  CaddyExactRouteSchema,
  CaddyManagedRouteEntrySchema,
  CaddyManagedRouteSchema,
  CaddyPreviewRouteSchema,
  CaddyRoutesStateSchema,
} from './schema'

export type CaddyClientOptions = input<typeof CaddyClientOptionsSchema>
export type ResolvedCaddyClientOptions = output<typeof CaddyClientOptionsSchema>

export type CaddyExactRoute = output<typeof CaddyExactRouteSchema>
export type CaddyPreviewRoute = output<typeof CaddyPreviewRouteSchema>
export type CaddyManagedRoute = output<typeof CaddyManagedRouteSchema>
export type CaddyManagedRouteEntry = output<typeof CaddyManagedRouteEntrySchema>
export type CaddyRoutesState = output<typeof CaddyRoutesStateSchema>

export type CaddyConfigMutationMethod = 'PUT' | 'PATCH' | 'DELETE'

export interface CaddyHttpJsonResponse<TData> {
  readonly data: TData
  readonly etag?: string
  readonly statusCode: number
}

export interface CaddyHttpMutationResponse {
  readonly etag?: string
  readonly statusCode: number
}
