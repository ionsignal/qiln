import { connect } from '@nats-io/transport-node'
import { NatsTransportError, NatsTransportErrorCode } from './errors'
import { NatsSubscriptionTracker } from './subscriptions'
import type { NatsConnection, Subscription } from '@nats-io/transport-node'

const DEFAULT_RECONNECT_ATTEMPTS = -1
const DEFAULT_RECONNECT_WAIT_MS = 2000
const DEFAULT_LOGGER_PREFIX = '[NatsConnectionManager]'

export interface NatsConnectionConfig {
  servers: string | string[]
  token?: string
  maxReconnectAttempts?: number
  reconnectTimeWait?: number
}

export interface NatsConnectionManagerOptions {
  loggerPrefix?: string
}

export type NatsSubscribeOptions = NonNullable<Parameters<NatsConnection['subscribe']>[1]>

export class NatsConnectionManager {
  private nc: NatsConnection | null = null
  private started = false
  private abortController = new AbortController()
  private readonly subscriptions = new NatsSubscriptionTracker()
  private readonly loggerPrefix: string

  constructor(
    private readonly config: NatsConnectionConfig,
    options: NatsConnectionManagerOptions = {},
  ) {
    this.loggerPrefix = options.loggerPrefix ?? DEFAULT_LOGGER_PREFIX
  }

  get signal(): AbortSignal {
    return this.abortController.signal
  }

  async start(): Promise<void> {
    if (this.started) {
      return
    }
    if (this.abortController.signal.aborted) {
      this.abortController = new AbortController()
    }
    try {
      this.nc = await connect({
        servers: this.config.servers,
        token: this.config.token ?? undefined,
        maxReconnectAttempts: this.config.maxReconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS,
        reconnectTimeWait: this.config.reconnectTimeWait ?? DEFAULT_RECONNECT_WAIT_MS,
      })
      this.started = true
      console.log(`${this.loggerPrefix} Connected to NATS: ${JSON.stringify(this.config.servers)}`)
    } catch (error: unknown) {
      console.error(`${this.loggerPrefix} FATAL: Failed to establish initial NATS connection.`, error)
      throw error
    }
  }

  async shutdown(): Promise<void> {
    this.abortController.abort()
    const nc = this.nc
    if (!this.started || !nc) {
      this.nc = null
      this.started = false
      this.subscriptions.clear()
      return
    }
    try {
      await nc.drain()
    } catch {
      console.warn(
        `${this.loggerPrefix} Drain errors during shutdown are expected when the connection is already closing.`,
      )
    } finally {
      this.nc = null
      this.started = false
      this.subscriptions.clear()
      console.log(`${this.loggerPrefix} NATS connection drained and closed.`)
    }
  }

  requireConnection(): NatsConnection {
    if (!this.nc || !this.started) {
      throw new NatsTransportError(`${this.loggerPrefix} NATS connection is not started.`, {
        code: NatsTransportErrorCode.NOT_STARTED,
      })
    }
    return this.nc
  }

  subscribe(subject: string, options?: NatsSubscribeOptions): Subscription {
    const nc = this.requireConnection()
    const subscription = options ? nc.subscribe(subject, options) : nc.subscribe(subject)
    return this.subscriptions.track(subscription)
  }

  untrack(subscription: Subscription): void {
    this.subscriptions.untrack(subscription)
  }

  unsubscribeSafely(subscription: Subscription): void {
    this.subscriptions.unsubscribeSafely(subscription)
  }
}
