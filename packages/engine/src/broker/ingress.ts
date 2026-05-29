import { formatError, type ZodError } from 'zod'
import { HostEventSchemaMap, isHostEventType } from '../schemas/events'
import { RoutingTable } from '../routing'
import { SubjectWildcards } from '../schemas/subjects'
import { UniversalSubjectParser } from '@qiln/core/server'
import type { EventEmitter } from 'node:events'
import type { Msg, Subscription } from '@nats-io/transport-node'
import type { BaseConnectionManager } from '@qiln/core/server'
import type { HostEventEnvelope } from '../types'
import type { HostEvent } from '../schemas/events'

/**
 * Handles subscribing to NATS and bridging events to the local Fastify dispatcher.
 */
export class IngressManager {
  private subscriptions: Subscription[] = []

  constructor(
    private readonly connection: BaseConnectionManager,
    private readonly events: EventEmitter,
    private readonly signal: AbortSignal,
  ) {}

  /**
   * Subscribes to all events and routes each message to the internal EventEmitter.
   * Automatically self-heals if the subscription is dropped by the server.
   */
  async start(): Promise<void> {
    if (!this.connection.nc || this.signal.aborted) return
    if (this.subscriptions.length > 0 && !this.subscriptions.some(s => s.isClosed())) return
    const subjects = [SubjectWildcards.ALL_EVENTS]
    this.subscriptions = this._setupSubscriptions(subjects)
    Promise.race(this.subscriptions.map(s => s.closed))
      .then(err => {
        if (this.signal.aborted) return
        this.subscriptions = [] // Clear state to allow clean restart
        console.warn(`[QilnEngine Broker] Event consumption stream terminated unexpectedly. Reason: ${err?.message || 'Unknown'}`)
        console.log('[QilnEngine Broker] Attempting to re-establish subscription in 3 seconds...')
        setTimeout(() => {
          void this.start()
        }, 3000)
      })
      .catch(() => {})
  }

  /**
   * Factory method to cleanly map subjects to NATS subscriptions
   */
  private _setupSubscriptions(subjects: string[]): Subscription[] {
    if (!this.connection.nc) return []
    return subjects.map(subject => {
      return this.connection.nc!.subscribe(subject, {
        callback: (err, msg) => {
          if (err) {
            console.error(`[QilnEngine Ingress] NATS transport error on message:`, err)
            return
          }
          try {
            this._processMessage(msg)
          } catch (processErr) {
            console.error(`[QilnEngine Ingress] Unexpected error processing message on subject '${msg.subject}':`, processErr)
          }
        },
      })
    })
  }

  /**
   * Decodes, validates, and routes a single inbound NATS message.
   */
  private _processMessage(msg: Msg): void {
    const parsed = UniversalSubjectParser.parse(msg.subject)
    if (!parsed) {
      console.warn(`[QilnEngine Broker] Unrecognised subject format: '${msg.subject}'`)
      return
    }
    const eventType = `${parsed.domain}.${parsed.action}`
    if (!isHostEventType(eventType)) {
      console.warn(`[QilnEngine Broker] Unknown event type in subject: '${eventType}'. Dropping message.`)
      return
    }
    const schema = HostEventSchemaMap[eventType]
    let rawData: unknown = {}
    try {
      rawData = msg.data.length > 0 ? msg.json() : {}
    } catch (err) {
      console.warn(`[QilnEngine Broker] Failed to parse JSON payload on subject '${msg.subject}'`)
      return
    }
    const parsedEvent = schema.safeParse(rawData)
    if (!parsedEvent.success) {
      console.warn(`[QilnEngine Broker] Malformed event payload on subject '${msg.subject}':`, formatError(parsedEvent.error as ZodError<unknown>))
      return
    }
    const event = parsedEvent.data as HostEvent
    const strategy = RoutingTable[event.type as keyof typeof RoutingTable]
    if (!strategy) {
      console.warn(`[QilnEngine Broker] No routing strategy for event type: '${event.type}'`)
      return
    }
    let routing: { type: 'broadcast' } | { type: 'unicast'; userId: string }
    if (strategy.type === 'broadcast') {
      routing = { type: 'broadcast' }
    } else {
      if (!('ownerId' in event) || typeof event.ownerId !== 'string') {
        console.warn(`[QilnEngine Broker] Dropping unicast message missing ownerId...`)
        return
      }
      routing = { type: 'unicast', userId: event.ownerId }
    }
    const envelope: HostEventEnvelope = {
      target: parsed.target,
      event,
      routing,
    }
    this.events.emit('event', envelope)
  }
}
