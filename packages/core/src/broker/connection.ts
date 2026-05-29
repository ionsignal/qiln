import { connect } from '@nats-io/transport-node'
import type { NatsConnection } from '@nats-io/transport-node'

export interface NatsBaseConfig {
  servers: string | string[]
  token?: string
}

export interface NatsConnectionProvider {
  get nc(): NatsConnection | null
}

/**
 * Centralizes the NATS connection state.
 */
export class BaseConnectionManager implements NatsConnectionProvider {
  private _nc: NatsConnection | null = null
  private _isConnected = false

  constructor(
    private readonly config: NatsBaseConfig,
    private readonly loggerPrefix: string,
  ) {}

  get nc(): NatsConnection | null {
    return this._nc
  }

  get isConnected(): boolean {
    return this._isConnected
  }

  /**
   * Connects to NATS.
   */
  async start(): Promise<void> {
    if (this._isConnected) return
    try {
      // Fail-Fast on Boot
      this._nc = await connect({
        servers: this.config.servers,
        token: this.config.token ?? undefined,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 2000,
      })
      this._isConnected = true
      console.log(`${this.loggerPrefix} Connected to NATS: ${JSON.stringify(this.config.servers)}`)
    } catch (error) {
      console.error(`${this.loggerPrefix} FATAL: Failed to establish initial NATS connection. Terminating boot sequence.`, error)
      throw error
    }
  }

  /**
   * Gracefully drains all subscriptions and closes the NATS connection.
   */
  async drain(): Promise<void> {
    if (!this._isConnected || !this._nc) return
    try {
      await this._nc.drain()
    } catch {
      console.warn(`${this.loggerPrefix} Drain errors during shutdown are expected when the connection is already closing.`)
    }
    this._isConnected = false
    console.log(`${this.loggerPrefix} NATS connection drained and closed.`)
  }
}
