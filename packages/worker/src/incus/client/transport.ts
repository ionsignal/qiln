import fs from 'node:fs'
import { WebSocket, type RawData, type ClientOptions } from 'ws'
import { Agent, fetch, type Response } from 'undici'
import { IncusError } from '../../errors'
import { IncusResponseSchema, IncusOperationSchema, IncusEventSchema, INCUS_FINAL } from '../../schemas/incus'
import type { WorkerIncusConfig } from '../../types'
import type { PendingOp, IIncusTransport, IncusRequestOptions, IncusRawRequestOptions } from './types'

// Maximum ms to wait for an async
// Incus operation to complete before rejecting.
const OP_TIMEOUT = 120_000

export class IncusTransport implements IIncusTransport {
  private readonly config: WorkerIncusConfig
  private readonly baseUrl: string
  private readonly wsUrl: string

  private agent: Agent
  private ws: WebSocket | null = null
  private closed = false
  private retries = 0
  private readonly pending = new Map<string, PendingOp>()

  private wsReadyPromise: Promise<void>
  private resolveWsReady!: () => void

  constructor(config: WorkerIncusConfig = {}) {
    this.config = config
    const query = '&all-projects=true'
    if (this.config.socketPath) {
      this.baseUrl = 'http://localhost/1.0'
      this.wsUrl = `ws+unix://${this.config.socketPath}:/1.0/events?type=operation${query}`
      this.agent = new Agent({
        connect: { socketPath: this.config.socketPath },
        connections: 100,
        pipelining: 10,
      })
    } else if (this.config.url) {
      this.baseUrl = `${this.config.url}/1.0`
      this.wsUrl = `${this.config.url.replace(/^http/, 'ws')}/1.0/events?type=operation${query}`
      this.agent = new Agent({
        connect: {
          rejectUnauthorized: this.config.rejectUnauthorized ?? false,
          ...(this.config.cert && this.config.key ? { cert: this.config.cert, key: this.config.key } : {}),
        },
        connections: 100,
        pipelining: 10,
      })
    } else {
      throw new IncusError('Invalid Incus config: Must provide socketPath OR url', 'TRANSPORT_ERROR')
    }

    this.wsReadyPromise = new Promise(r => (this.resolveWsReady = r))
  }

  /**
   * Pre-flight check to ensure transport connectivity.
   */
  public async init() {
    if (this.config.socketPath) {
      try {
        fs.accessSync(this.config.socketPath, fs.constants.R_OK | fs.constants.W_OK)
      } catch {
        throw new IncusError(
          `Cannot access Incus socket at ${this.config.socketPath}. Ensure the Node.js process has correct permissions.`,
          'TRANSPORT_ERROR',
        )
      }
    }
    // TODO: Make initial Incus HTTP/WebSocket readiness bounded and awaited before Worker startup continues.
    // Async operations must register their timeout before waiting for WebSocket readiness, with HTTP probing
    // and WebSocket events acting as completion mechanisms.
    void this.connect()
  }

  /**
   * Gracefully closes the WebSocket event stream and rejects all in-flight operations.
   */
  public destroy(): void {
    if (this.closed) return
    this.closed = true
    this.pending.forEach(({ timer, reject }) => {
      clearTimeout(timer)
      reject(new IncusError('Incus client is shutting down', 'TRANSPORT_ERROR'))
    })
    this.pending.clear()
    this.ws?.close(1000, 'shutting down')
    this.ws = null
  }

  private connect(): void {
    if (this.ws !== null || this.closed) return
    const wsOptions: ClientOptions = { headers: {} }
    if (!this.config.socketPath) {
      wsOptions.rejectUnauthorized = this.config.rejectUnauthorized ?? false
      wsOptions.cert = this.config.cert
      wsOptions.key = this.config.key
      if (this.config.authToken) {
        wsOptions.headers!['Authorization'] = `Basic ${Buffer.from(this.config.authToken).toString('base64')}`
      }
    }
    this.ws = new WebSocket(this.wsUrl, wsOptions)
    this.ws.on('open', () => {
      this.retries = 0
      this.resolveWsReady()
      void this.reconcile()
    })
    this.ws.on('message', (data: RawData) => {
      try {
        const result = IncusEventSchema.safeParse(JSON.parse(data.toString()))
        if (!result.success || result.data.type !== 'operation') return
        this.onOp(result.data.metadata)
      } catch {
        console.warn('[IncusClient] Malformed frame — ignore, stream continues')
      }
    })
    this.ws.on('error', err => {
      console.error('[IncusClient] Event stream error:', err.message)
    })
    this.ws.on('close', () => {
      this.ws = null
      this.wsReadyPromise = new Promise(r => (this.resolveWsReady = r))
      this.reconnect()
    })
  }

  private reconnect(): void {
    if (this.closed) return
    const delay = Math.min(1000 * Math.pow(2, this.retries), 30_000)
    this.retries++
    console.warn(`[IncusClient] Event stream disconnected. Reconnecting in ${delay}ms (attempt ${this.retries})...`)
    setTimeout(() => this.connect(), delay)
  }

  private onOp(metadata: unknown): void {
    const result = IncusOperationSchema.safeParse(metadata)
    if (!result.success) return
    const op = result.data
    const entry = this.pending.get(op.id)
    if (!entry || !INCUS_FINAL.has(op.status_code)) return
    clearTimeout(entry.timer)
    this.pending.delete(op.id)
    if (op.status_code === 200) {
      entry.resolve()
    } else {
      entry.reject(
        new IncusError(`Incus operation failed: ${op.err ?? op.status}`, 'API_ERROR', {
          status: op.status,
          code: op.status_code,
        }),
      )
    }
  }

  private async probe(id: string): Promise<void> {
    const op = this.pending.get(id)
    if (!op) return
    try {
      const { data } = await this.request(`/operations/${id}`, 'GET', { project: op.project })
      this.onOp(data)
    } catch {
      console.warn('[IncusClient] Not yet final or unreachable — the WS event or the timeout will handle it')
    }
  }

  private async reconcile(): Promise<void> {
    if (this.pending.size === 0) return
    console.log(`[IncusClient] Reconciling ${this.pending.size} in-flight operation(s) after reconnect...`)
    for (const id of this.pending.keys()) {
      await this.probe(id)
    }
  }

  /**
   * Safely injects the project query parameter into API paths.
   */
  private applyQueryAttributes(path: string, options?: { project?: string }): string {
    const project = options?.project
    if (!project) return path
    const url = new URL(path, 'http://localhost')
    if (!url.searchParams.has('project') && !url.searchParams.has('all-projects')) {
      url.searchParams.set('project', project)
    }
    return `${url.pathname}${url.search}`
  }

  /**
   * Internal wrapper for synchronous Incus requests.
   */
  public async request(path: string, method: string, options?: IncusRequestOptions): Promise<{ data: unknown; etag?: string }> {
    const headers = new Headers()
    if (options?.body) headers.set('Content-Type', 'application/json')
    if (this.config.authToken) headers.set('Authorization', `Basic ${Buffer.from(this.config.authToken).toString('base64')}`)
    if (options?.etag) headers.set('If-Match', options.etag)
    if (options?.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        headers.set(key, value) // Cleanly overwrites duplicates regardless of case
      }
    }
    const finalPath = this.applyQueryAttributes(path, options)
    const res = await fetch(`${this.baseUrl}${finalPath}`, {
      method,
      dispatcher: this.agent,
      body: options?.body ? JSON.stringify(options.body) : undefined,
      headers,
    }).catch(err => {
      throw new IncusError(`Incus Transport Error: ${err.message}`, 'TRANSPORT_ERROR')
    })
    const raw = await res.json()
    const envelope = IncusResponseSchema.safeParse(raw)
    if (!envelope.success) {
      throw new IncusError('Malformed Incus Response Envelope', 'VALIDATION_ERROR', envelope.error.format())
    }
    if (envelope.data.type === 'error') {
      if (envelope.data.error_code === 404) throw new IncusError(envelope.data.error, 'NOT_FOUND')
      throw new IncusError(envelope.data.error, 'API_ERROR', { code: envelope.data.error_code })
    }
    if (envelope.data.type === 'async') {
      throw new IncusError('Expected sync response, got async operation', 'API_ERROR')
    }
    const etag = res.headers.get('etag') ?? undefined
    return { data: envelope.data.metadata, etag }
  }

  /**
   * Internal wrapper for requestRaw used in Incus File API requests that deal in raw bytes rather than JSON
   * This bypasses JSON stringification of the body and avoids expecting a JSON envelope on return.
   */
  public async raw(path: string, method: string, options?: IncusRawRequestOptions): Promise<Response> {
    const headers = new Headers()
    if (options?.body) headers.set('Content-Type', 'application/octet-stream')
    if (this.config.authToken) headers.set('Authorization', `Basic ${Buffer.from(this.config.authToken).toString('base64')}`)
    if (options?.etag) headers.set('If-Match', options.etag)
    if (options?.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        headers.set(key, value)
      }
    }
    const finalPath = this.applyQueryAttributes(path, options)
    const res = await fetch(`${this.baseUrl}${finalPath}`, {
      method,
      dispatcher: this.agent,
      body: options?.body,
      headers,
    }).catch(err => {
      throw new IncusError(`Incus Transport Error: ${err.message}`, 'TRANSPORT_ERROR')
    })
    if (!res.ok) {
      let errorMsg = `HTTP Error ${res.status}`
      const textBody = await res.text().catch(() => '')
      try {
        if (textBody) {
          const raw = JSON.parse(textBody)
          const envelope = IncusResponseSchema.safeParse(raw)
          if (envelope.success && envelope.data.type === 'error') {
            errorMsg = envelope.data.error
          }
        }
      } catch {
        // Fallback to raw text if it wasn't valid JSON
        errorMsg = textBody || errorMsg
      }
      if (res.status === 404) throw new IncusError(errorMsg, 'NOT_FOUND')
      if (res.status === 403) throw new IncusError(errorMsg, 'FORBIDDEN')
      throw new IncusError(errorMsg, 'API_ERROR', { code: res.status })
    }
    return res
  }

  /**
   * Internal wrapper for asynchronous Incus requests.
   * Resolves via the WebSocket event stream rather than HTTP long-polling.
   */
  public async operation(path: string, method: string, options?: IncusRequestOptions): Promise<void> {
    const headers = new Headers()
    if (options?.body) headers.set('Content-Type', 'application/json')
    if (this.config.authToken) headers.set('Authorization', `Basic ${Buffer.from(this.config.authToken).toString('base64')}`)
    if (options?.etag) headers.set('If-Match', options.etag)
    if (options?.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        headers.set(key, value)
      }
    }
    const finalPath = this.applyQueryAttributes(path, options)
    const res = await fetch(`${this.baseUrl}${finalPath}`, {
      method,
      dispatcher: this.agent,
      body: options?.body ? JSON.stringify(options.body) : undefined,
      headers,
    }).catch(err => {
      throw new IncusError(`Incus Transport Error: ${err.message}`, 'TRANSPORT_ERROR')
    })
    if (res.status === 401 || res.status === 403) {
      throw new IncusError(`Incus Transport Error: ${res.status} Unauthorized/Forbidden`, 'FORBIDDEN')
    }
    const raw = await res.json()
    const envelope = IncusResponseSchema.safeParse(raw)
    if (!envelope.success) {
      throw new IncusError('Malformed Incus Response Envelope', 'VALIDATION_ERROR', envelope.error.format())
    }
    if (envelope.data.type === 'error') {
      if (envelope.data.error_code === 404) {
        throw new IncusError(envelope.data.error, 'NOT_FOUND')
      }
      throw new IncusError(envelope.data.error, 'API_ERROR', { code: envelope.data.error_code })
    }
    if (envelope.data.type === 'sync') {
      console.warn('[IncusClient] Incus returned sync for action instantly resolved')
      return
    }
    const operationId = envelope.data.metadata.id
    await this.wsReadyPromise
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(operationId)
        reject(new IncusError(`Operation ${operationId} timed out`, 'API_ERROR'))
      }, OP_TIMEOUT)
      this.pending.set(operationId, { resolve, reject, timer, project: options?.project })
      void this.probe(operationId)
    })
  }
}

/**
 * A proxy class that wraps an existing IIncusTransport and automatically injects
 * a specific project scope into all requests, preventing the need to duplicate
 * underlying WebSocket connections.
 */
export class ScopedIncusTransport implements IIncusTransport {
  constructor(
    private readonly transport: IIncusTransport,
    private readonly project: string,
  ) {}

  public async request(path: string, method: string, options?: IncusRequestOptions): Promise<{ data: unknown; etag?: string }> {
    return this.transport.request(path, method, { ...options, project: this.project })
  }

  public async raw(path: string, method: string, options?: IncusRawRequestOptions): Promise<Response> {
    return this.transport.raw(path, method, { ...options, project: this.project })
  }

  public async operation(path: string, method: string, options?: IncusRequestOptions): Promise<void> {
    return this.transport.operation(path, method, { ...options, project: this.project })
  }
}
