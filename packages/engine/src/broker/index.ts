import { on, EventEmitter } from 'node:events'
import { BaseConnectionManager, BaseEgressManager } from '@qiln/core/server'
import { IngressManager } from './ingress'
import { RpcManager } from './rpc'
import { HostEventSchema } from '../schemas/events'
import { SubjectPrefix } from '../schemas/subjects'
import type { ZodType, output } from 'zod'
import type { HostEvent } from '../schemas/events'
import type { HostEventBroker, HostNatsConfig, HostEventEnvelope } from '../types'

/**
 * Orchestrates the sub-modules while maintaining the exact `HostEventBroker` contract.
 */
export class NatsBroker implements HostEventBroker {
  private readonly connection: BaseConnectionManager
  private readonly ingress: IngressManager
  private readonly egress: BaseEgressManager<HostEvent>
  private readonly rpc: RpcManager
  private readonly abortController = new AbortController()
  private readonly events = new EventEmitter()

  constructor(config: HostNatsConfig) {
    this.connection = new BaseConnectionManager(config, '[QilnEngine Broker]')
    this.ingress = new IngressManager(this.connection, this.events, this.abortController.signal)
    this.egress = new BaseEgressManager<HostEvent>(this.connection, HostEventSchema, SubjectPrefix.EVENT, '[QilnEngine Egress]')
    this.rpc = new RpcManager(this.connection)
  }

  /**
   * Connects to NATS and begins consuming inbound events.
   */
  async start(): Promise<void> {
    await this.connection.start()
    void this.ingress.start()
  }

  /**
   * Gracefully drains all subscriptions and closes the NATS connection.
   */
  async shutdown(): Promise<void> {
    this.abortController.abort()
    await this.connection.drain()
  }

  /**
   * Publishes an event to the infrastructure domain.
   */
  async publish(target: string, event: HostEvent): Promise<void> {
    return this.egress.publish(target, event)
  }

  /**
   * Registers the request method with two-step parsing.
   */
  async request<TOutput extends ZodType>(
    subject: string,
    payload: unknown,
    responseSchema: TOutput,
    timeoutMs?: number,
  ): Promise<output<TOutput>> {
    return this.rpc.request(subject, payload, responseSchema, timeoutMs)
  }

  /**
   * Registers a NATS request/reply responder.
   */
  serve(subject: string, handler: (subject: string, data: unknown) => Promise<unknown>, opts?: { queue?: string }): void {
    return this.rpc.serve(subject, handler, opts)
  }

  /**
   * Returns an async iterable of all inbound events passing the given filter.
   */
  async *subscribe(filter: (event: HostEvent) => boolean): AsyncIterable<HostEventEnvelope> {
    try {
      const iterator = on(this.events, 'event', { signal: this.abortController.signal })
      for await (const [envelope] of iterator) {
        const env = envelope as HostEventEnvelope
        if (filter(env.event)) {
          yield env
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name !== 'AbortError') {
        throw error
      }
    }
  }
}
