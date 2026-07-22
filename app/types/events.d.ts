import type { CapsuleEvent } from '@qiln/core/client'

/**
 * The base requirement for ANY event flowing through the system.
 */
export interface BaseEvent {
  type: string
}

/**
 * The ultimate union of all possible events in the application. The Vue
 * frontend will receive this type from the tRPC subscription.
 */
export type AppEvent = CapsuleEvent

/**
 * Compatibility envelope type retained for call sites that still model targeted
 * event delivery, even though Fastify no longer owns the dispatcher bridge.
 */
export interface DispatcherEnvelope<TEvent = AppEvent> {
  target: string
  event: TEvent
}
