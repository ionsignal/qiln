import { CapsuleRouteService } from '../routing/service'
import { CapsuleRouteStore } from '../routing/store'
import { RouteOperationClassification } from '../operations/routing/classification'
import { createRouteOperationAbandonmentHandlers } from '../operations/routing/abandonment'
import type { CapsuleOperationAbandonmentHandler } from '../operations/abandonment'
import type { CapsuleOperationEventPublisher, CapsuleRouteEventPublisher } from '../events'
import type { CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

export interface ComposeRoutingCapabilityOptions<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  persistence: CapsulePersistence<TDatabase, TTables>
  operationEvents: CapsuleOperationEventPublisher
  routeEvents: CapsuleRouteEventPublisher
}

export interface ComposedRoutingCapability {
  service: CapsuleRouteService
  abandonment: readonly CapsuleOperationAbandonmentHandler[]
}

/**
 * Composes committed route reads and startup abandonment classification.
 *
 * This capability contains no promote or rollback submission service and has no
 * Caddy client.
 */
export function composeRoutingCapability<TDatabase extends PostgresJsDatabase, TTables extends CapsuleTables>(
  options: ComposeRoutingCapabilityOptions<TDatabase, TTables>,
): ComposedRoutingCapability {
  const routes = new CapsuleRouteStore(options.persistence)
  const service = new CapsuleRouteService(routes)
  const classification = new RouteOperationClassification(options.persistence)
  const abandonment = createRouteOperationAbandonmentHandlers({
    classification,
    operationEvents: options.operationEvents,
    routeEvents: options.routeEvents,
  })
  return {
    service,
    abandonment,
  }
}
