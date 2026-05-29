import { HostEventType } from './schemas/constants'

export type RoutingStrategy = { type: 'broadcast' } | { type: 'unicast' }

/**
 * The Declarative Routing Table.
 * Maps every HostEventType to a specific distribution strategy for the Fastify Dispatcher.
 */
export const RoutingTable: Record<HostEventType, RoutingStrategy> = {
  [HostEventType.INSTANCE_STATE]: { type: 'unicast' },
  [HostEventType.INSTANCE_DELETED]: { type: 'unicast' },
}
