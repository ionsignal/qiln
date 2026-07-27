import { z } from 'zod'
import {
  CapsuleRouteAliasListOutputSchema,
  CapsuleRouteAliasNameSchema,
  CapsuleRouteAliasStatusSchema,
} from '../../../schemas/capsule/routing'
import { TargetOwnerSchema, TargetType } from '../targets'
import { defineCapsuleCommand, defineCapsuleEvent } from './definitions'
import type { input, output } from 'zod'
import type { CapsuleCommandDefinition, CapsuleEventDefinition } from './definitions'

const CAPSULE_ROUTES_LIST_TIMEOUT_MS = 15_000

/**
 * Route commands expose only committed alias reads in the durable-ledger phase.
 *
 * Promotion and rollback command contracts remain intentionally absent until
 * Worker acceptance, actor-separation policy, Caddy execution, verification,
 * and operation-specific failure classification are implemented.
 */
export const CapsuleRouteCommandName = {
  ROUTES_LIST: 'capsule.routes.list',
} as const

export type CapsuleRouteCommandName = (typeof CapsuleRouteCommandName)[keyof typeof CapsuleRouteCommandName]
export const CapsuleRouteCommandNameValues = [CapsuleRouteCommandName.ROUTES_LIST] as const

export const CapsuleRouteEventName = {
  ROUTE_CHANGED: 'capsule.route.changed',
} as const

export type CapsuleRouteEventName = (typeof CapsuleRouteEventName)[keyof typeof CapsuleRouteEventName]
export const CapsuleRouteEventNameValues = [CapsuleRouteEventName.ROUTE_CHANGED] as const

export const CapsuleRoutesListInputSchema = z
  .object({
    target: TargetOwnerSchema,
    capsuleId: z.uuid(),
  })
  .strict()

export const CapsuleRoutesListOutputSchema = CapsuleRouteAliasListOutputSchema

export type CapsuleRoutesListInput = input<typeof CapsuleRoutesListInputSchema>
export type CapsuleRoutesList = output<typeof CapsuleRoutesListInputSchema>
export type CapsuleRoutesListOutput = output<typeof CapsuleRoutesListOutputSchema>

/**
 * Best-effort invalidation for committed route state.
 *
 * `currentRevisionId` remains null when an alias has no committed head.
 * Consumers must refetch authoritative committed alias state after receiving
 * this event or reconnecting.
 */
export const CapsuleRouteChangedEventSchema = z
  .object({
    type: z.literal(CapsuleRouteEventName.ROUTE_CHANGED),
    target: TargetOwnerSchema,
    capsuleId: z.uuid(),
    aliasId: z.uuid(),
    aliasName: CapsuleRouteAliasNameSchema,
    aliasStatus: CapsuleRouteAliasStatusSchema,
    currentRevisionId: z.uuid().nullable(),
  })
  .strict()

export type CapsuleRouteChangedEvent = z.infer<typeof CapsuleRouteChangedEventSchema>

export const CapsuleRouteEventSchemas = [CapsuleRouteChangedEventSchema] as const

export const CapsuleRouteCommandDefinitions = {
  [CapsuleRouteCommandName.ROUTES_LIST]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleRouteCommandName.ROUTES_LIST,
    inputSchema: CapsuleRoutesListInputSchema,
    outputSchema: CapsuleRoutesListOutputSchema,
    timeoutMs: CAPSULE_ROUTES_LIST_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleRoutesList) {
        return payload.target
      },
    },
  }),
} as const satisfies Record<CapsuleRouteCommandName, CapsuleCommandDefinition>

export const CapsuleRouteEventDefinitions = {
  [CapsuleRouteEventName.ROUTE_CHANGED]: defineCapsuleEvent({
    kind: 'capsule.event',
    name: CapsuleRouteEventName.ROUTE_CHANGED,
    schema: CapsuleRouteChangedEventSchema,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleRouteChangedEvent) {
        return payload.target
      },
    },
  }),
} as const satisfies Record<CapsuleRouteEventName, CapsuleEventDefinition>
