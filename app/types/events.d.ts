import type { HostEvent } from '@qiln/engine/client'

/**
 * The base requirement for ANY event flowing through the system.
 */
export interface BaseEvent {
  type: string
  [key: string]: any
}

/**
 * The universal envelope used by the Fastify Dispatcher.
 */
export interface DispatcherEnvelope<TEvent extends BaseEvent = BaseEvent> {
  target: string
  event: TEvent
}

/**
 * The ultimate union of all possible events in the application.
 * The Vue frontend will receive this type from the tRPC subscription.
 */
export type AppEvent = HostEvent
