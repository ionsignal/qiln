import type { input, output } from 'zod'
import type {
  CaddyAliasRouteEntrySchema,
  CaddyAliasRouteSchema,
  CaddyAliasesStateSchema,
  CaddyClientOptionsSchema,
} from './schema'

export type CaddyClientOptions = input<typeof CaddyClientOptionsSchema>
export type ResolvedCaddyClientOptions = output<typeof CaddyClientOptionsSchema>

export type CaddyAliasRoute = output<typeof CaddyAliasRouteSchema>
export type CaddyAliasRouteEntry = output<typeof CaddyAliasRouteEntrySchema>
export type CaddyAliasesState = output<typeof CaddyAliasesStateSchema>

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
