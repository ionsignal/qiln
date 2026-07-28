import { WebSocket, type ClientOptions, type RawData } from 'ws'
import { IncusEventSchema } from '../schemas/response'
import type { WorkerIncusConfig } from '../../../types'
import type { IncusEndpoints, OperationObserver } from './types'

const MAX_RECONNECT_DELAY_MS = 30_000

export interface IncusEventsOptions {
  config: WorkerIncusConfig
  endpoints: IncusEndpoints
  observe: OperationObserver
  reconcile: () => Promise<void>
}

/**
 * Owns the Incus operation-event WebSocket lifecycle.
 *
 * The stream forwards validated provider observations to the operation tracker.
 * It does not own pending operation records, deadlines, probes, settlement, or
 * mutation submission.
 */
export class IncusEvents {
  private readonly config: WorkerIncusConfig
  private readonly eventUrl: string
  private readonly usesSocket: boolean
  private readonly observe: OperationObserver
  private readonly reconcile: () => Promise<void>

  private socket: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private retries = 0

  constructor(options: IncusEventsOptions) {
    this.config = options.config
    this.eventUrl = options.endpoints.eventUrl
    this.usesSocket = options.endpoints.socketPath !== undefined
    this.observe = options.observe
    this.reconcile = options.reconcile
  }

  /**
   * Starts the event stream without making provider-operation progress depend
   * on WebSocket readiness.
   */
  public start(): void {
    if (this.closed) {
      return
    }
    this.connect()
  }

  public stop(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const socket = this.socket
    this.socket = null
    if (!socket) {
      return
    }
    try {
      socket.close(1000, 'shutting down')
    } catch {
      // The socket may already be closing after a transport failure.
    }
  }

  private connect(): void {
    if (this.closed || this.socket !== null) {
      return
    }
    const socket = new WebSocket(this.eventUrl, this.options())
    this.socket = socket
    socket.on('open', () => {
      if (this.closed || this.socket !== socket) {
        try {
          socket.close(1000, 'stale connection')
        } catch {
          // A stale event stream has no transport authority.
        }
        return
      }
      this.retries = 0
      void this.reconcile().catch((error: unknown) => {
        if (!this.closed) {
          console.warn('[IncusEvents] Failed to reconcile pending operations after event-stream connection.', error)
        }
      })
    })
    socket.on('message', (data: RawData) => {
      if (this.closed || this.socket !== socket) {
        return
      }

      this.message(data)
    })
    socket.on('error', error => {
      if (!this.closed) {
        console.error('[IncusEvents] Event stream error:', error.message)
      }
    })
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null
      }
      if (!this.closed) {
        this.reconnectLater()
      }
    })
  }

  private message(data: RawData): void {
    let raw: unknown
    try {
      raw = JSON.parse(data.toString())
    } catch {
      console.warn('[IncusEvents] Malformed event frame ignored; the stream remains active.')
      return
    }
    const event = IncusEventSchema.safeParse(raw)
    if (!event.success || event.data.type !== 'operation') {
      return
    }
    this.observe(event.data.metadata)
  }

  private reconnectLater(): void {
    if (this.closed || this.reconnectTimer) {
      return
    }
    const delay = Math.min(1_000 * Math.pow(2, this.retries), MAX_RECONNECT_DELAY_MS)
    this.retries++
    console.warn(`[IncusEvents] Event stream disconnected. Reconnecting in ${delay}ms (attempt ${this.retries})...`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private options(): ClientOptions {
    const options: ClientOptions = {
      headers: {},
    }
    if (this.usesSocket) {
      return options
    }
    options.rejectUnauthorized = this.config.rejectUnauthorized ?? false
    options.cert = this.config.cert
    options.key = this.config.key
    if (this.config.basicAuth) {
      options.headers!['Authorization'] = `Basic ${Buffer.from(this.config.basicAuth).toString('base64')}`
    }
    return options
  }
}
