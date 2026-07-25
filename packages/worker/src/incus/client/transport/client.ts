import fs from 'node:fs'
import { WebSocket, type ClientOptions, type RawData } from 'ws'
import { Agent, fetch, type Response } from 'undici'
import { IncusError } from '../../../errors'
import { INCUS_FINAL, IncusEventSchema, IncusOperationSchema, IncusResponseSchema } from '../schemas/response'
import { detailsFromUnknown, messageFromUnknown } from './error'
import type { WorkerIncusConfig } from '../../../types'
import type { IIncusTransport, IncusRawRequestOptions, IncusRequestOptions } from '../types'
import type { OperationDeadline, OperationSettlement, PendingOperation } from './types'

/**
 * One overall deadline covers mutation submission, response parsing, pending
 * registration, WebSocket observation, HTTP probing, and reconnect
 * reconciliation.
 */
const OPERATION_TIMEOUT_MS = 120_000
const OPERATION_PROBE_INTERVAL_MS = 2_000
const MAX_RECONNECT_DELAY_MS = 30_000

/**
 * Shared Incus transport.
 *
 * Async provider operations do not depend on WebSocket readiness for progress.
 * Once an Incus operation ID is returned, it is registered immediately and may
 * complete through either:
 *
 * - A terminal WebSocket event;
 * - An HTTP operation probe;
 * - Reconnect reconciliation.
 *
 * Every completion mechanism converges through `settle()`, which guarantees
 * exactly one terminal settlement per registered operation.
 */
export class IncusTransport implements IIncusTransport {
  private readonly config: WorkerIncusConfig
  private readonly baseUrl: string
  private readonly wsUrl: string
  private readonly agent: Agent

  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private retries = 0

  private readonly pending = new Map<string, PendingOperation>()
  private readonly operationControllers = new Set<AbortController>()

  constructor(config: WorkerIncusConfig = {}) {
    this.config = config
    const eventQuery = '&all-projects=true'

    if (this.config.socketPath) {
      this.baseUrl = 'http://localhost/1.0'
      this.wsUrl = `ws+unix://${this.config.socketPath}:/1.0/events?type=operation${eventQuery}`
      this.agent = new Agent({
        connect: {
          socketPath: this.config.socketPath,
        },
        connections: 100,
        pipelining: 10,
      })
      return
    }

    if (this.config.url) {
      this.baseUrl = `${this.config.url}/1.0`
      this.wsUrl = `${this.config.url.replace(/^http/, 'ws')}/1.0/events?type=operation${eventQuery}`
      this.agent = new Agent({
        connect: {
          rejectUnauthorized: this.config.rejectUnauthorized ?? false,
          ...(this.config.cert && this.config.key
            ? {
                cert: this.config.cert,
                key: this.config.key,
              }
            : {}),
        },
        connections: 100,
        pipelining: 10,
      })
      return
    }

    throw new IncusError('Invalid Incus config: Must provide socketPath OR url', 'TRANSPORT_ERROR')
  }

  /**
   * Performs the local Unix-socket preflight and starts the event stream.
   *
   * Provider operations do not wait indefinitely for this stream. HTTP probing
   * remains an independent completion path while the stream is unavailable.
   */
  public async init(): Promise<void> {
    this.assertOpen()

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

    this.connect()
  }

  /**
   * Closes provider connectivity and rejects all registered asynchronous
   * operations through the same guarded settlement path used by normal
   * completion.
   *
   * HTTP mutation submissions that have not yet returned an operation ID are
   * also aborted. Their provider outcome must be treated as unknown.
   */
  public destroy(): void {
    if (this.closed) {
      return
    }

    this.closed = true

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    const shutdownError = this.createShutdownError()

    for (const operationId of [...this.pending.keys()]) {
      this.settle(operationId, {
        ok: false,
        error: shutdownError,
      })
    }

    for (const controller of this.operationControllers) {
      if (!controller.signal.aborted) {
        controller.abort()
      }
    }

    const ws = this.ws
    this.ws = null

    if (ws) {
      try {
        ws.close(1000, 'shutting down')
      } catch {
        // The socket may already be closing as part of a transport failure.
      }
    }

    try {
      void this.agent.destroy().catch((error: unknown) => {
        console.warn('[IncusClient] Failed to destroy the Incus HTTP agent during shutdown.', error)
      })
    } catch (error: unknown) {
      console.warn('[IncusClient] Failed to begin Incus HTTP agent shutdown.', error)
    }
  }

  /**
   * Performs a synchronous Incus request and validates the universal response
   * envelope.
   */
  public async request(
    path: string,
    method: string,
    options?: IncusRequestOptions,
  ): Promise<{ data: unknown; etag?: string }> {
    this.assertOpen()

    const headers = this.buildHeaders(options)

    if (options?.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }

    const finalPath = this.applyQuery(path, options)
    let response: Response

    try {
      response = await fetch(`${this.baseUrl}${finalPath}`, {
        method,
        dispatcher: this.agent,
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
        headers,
        signal: options?.signal,
      })
    } catch (error: unknown) {
      throw new IncusError(`Incus transport request failed: ${messageFromUnknown(error)}`, 'TRANSPORT_ERROR', {
        path: finalPath,
        method,
        aborted: options?.signal?.aborted ?? false,
        error: detailsFromUnknown(error),
      })
    }

    let raw: unknown

    try {
      raw = await response.json()
    } catch (error: unknown) {
      throw new IncusError('Failed to parse Incus response JSON.', 'VALIDATION_ERROR', {
        path: finalPath,
        method,
        status: response.status,
        error: detailsFromUnknown(error),
      })
    }

    const envelope = IncusResponseSchema.safeParse(raw)

    if (!envelope.success) {
      throw new IncusError('Malformed Incus Response Envelope', 'VALIDATION_ERROR', envelope.error.format())
    }

    if (envelope.data.type === 'error') {
      if (envelope.data.error_code === 404) {
        throw new IncusError(envelope.data.error, 'NOT_FOUND')
      }

      if (envelope.data.error_code === 401 || envelope.data.error_code === 403) {
        throw new IncusError(envelope.data.error, 'FORBIDDEN', {
          code: envelope.data.error_code,
        })
      }

      if (envelope.data.error_code === 409) {
        throw new IncusError(envelope.data.error, 'CONFLICT', {
          code: envelope.data.error_code,
        })
      }

      throw new IncusError(envelope.data.error, 'API_ERROR', {
        code: envelope.data.error_code,
      })
    }

    if (envelope.data.type === 'async') {
      throw new IncusError('Expected sync response, got async operation', 'API_ERROR')
    }

    const etag = response.headers.get('etag') ?? undefined

    return {
      data: envelope.data.metadata,
      etag,
    }
  }

  /**
   * Performs a raw Incus request for file operations.
   *
   * Raw byte requests must not inherit JSON content type. File uploads default
   * to `application/octet-stream` unless the caller provides a more specific
   * content type.
   */
  public async raw(path: string, method: string, options?: IncusRawRequestOptions): Promise<Response> {
    this.assertOpen()

    const headers = this.buildHeaders(options)

    if (options?.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/octet-stream')
    }

    const finalPath = this.applyQuery(path, options)
    let response: Response

    try {
      response = await fetch(`${this.baseUrl}${finalPath}`, {
        method,
        dispatcher: this.agent,
        body: options?.body,
        headers,
        signal: options?.signal,
      })
    } catch (error: unknown) {
      throw new IncusError(`Incus transport request failed: ${messageFromUnknown(error)}`, 'TRANSPORT_ERROR', {
        path: finalPath,
        method,
        aborted: options?.signal?.aborted ?? false,
        error: detailsFromUnknown(error),
      })
    }

    if (response.ok) {
      return response
    }

    let errorMessage = `HTTP Error ${response.status}`
    const textBody = await response.text().catch(() => '')

    if (textBody) {
      try {
        const raw: unknown = JSON.parse(textBody)
        const envelope = IncusResponseSchema.safeParse(raw)

        if (envelope.success && envelope.data.type === 'error') {
          errorMessage = envelope.data.error
        } else {
          errorMessage = textBody
        }
      } catch {
        errorMessage = textBody
      }
    }

    if (response.status === 404) {
      throw new IncusError(errorMessage, 'NOT_FOUND')
    }

    if (response.status === 401 || response.status === 403) {
      throw new IncusError(errorMessage, 'FORBIDDEN')
    }

    if (response.status === 409) {
      throw new IncusError(errorMessage, 'CONFLICT')
    }

    throw new IncusError(errorMessage, 'API_ERROR', {
      code: response.status,
    })
  }

  /**
   * Performs one bounded asynchronous Incus mutation.
   *
   * The deadline starts before HTTP submission. Once an asynchronous response
   * exposes an operation ID, the operation is registered synchronously before
   * waiting for either the event stream or a probe.
   */
  public async operation(path: string, method: string, options?: IncusRequestOptions): Promise<void> {
    this.assertOpen()

    const deadline = this.createDeadline(path)
    this.operationControllers.add(deadline.controller)

    try {
      const headers = this.buildHeaders(options)

      if (options?.body !== undefined && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json')
      }

      const finalPath = this.applyQuery(path, options)
      let response: Response

      try {
        response = await fetch(`${this.baseUrl}${finalPath}`, {
          method,
          dispatcher: this.agent,
          body: options?.body === undefined ? undefined : JSON.stringify(options.body),
          headers,
          signal: deadline.controller.signal,
        })
      } catch (error: unknown) {
        throw this.createSubmissionFailure(path, method, deadline, error)
      }

      if (response.status === 401 || response.status === 403) {
        throw new IncusError(`Incus Transport Error: ${response.status} Unauthorized/Forbidden`, 'FORBIDDEN')
      }

      let raw: unknown

      try {
        raw = await response.json()
      } catch (error: unknown) {
        throw this.createSubmissionFailure(path, method, deadline, error)
      }

      const envelope = IncusResponseSchema.safeParse(raw)

      if (!envelope.success) {
        throw new IncusError('Malformed Incus Response Envelope', 'VALIDATION_ERROR', {
          validation: envelope.error.format(),
          path,
          method,
          uncertainProviderOutcome: true,
        })
      }

      if (envelope.data.type === 'error') {
        if (envelope.data.error_code === 404) {
          throw new IncusError(envelope.data.error, 'NOT_FOUND')
        }

        if (envelope.data.error_code === 401 || envelope.data.error_code === 403) {
          throw new IncusError(envelope.data.error, 'FORBIDDEN', {
            code: envelope.data.error_code,
          })
        }

        if (envelope.data.error_code === 409) {
          throw new IncusError(envelope.data.error, 'CONFLICT', {
            code: envelope.data.error_code,
          })
        }

        throw new IncusError(envelope.data.error, 'API_ERROR', {
          code: envelope.data.error_code,
          terminalProviderStateObserved: true,
        })
      }

      this.assertDeadline(deadline)

      if (envelope.data.type === 'sync') {
        return
      }

      const operationId = envelope.data.metadata.id
      const completion = this.register(operationId, options?.project, deadline)

      await completion
    } finally {
      this.operationControllers.delete(deadline.controller)
      this.disposeDeadline(deadline)
    }
  }

  /**
   * Starts the Incus event stream without making provider-operation progress
   * depend on its readiness.
   */
  private connect(): void {
    if (this.ws !== null || this.closed) {
      return
    }

    const options: ClientOptions = {
      headers: {},
    }

    if (!this.config.socketPath) {
      options.rejectUnauthorized = this.config.rejectUnauthorized ?? false
      options.cert = this.config.cert
      options.key = this.config.key

      if (this.config.authToken) {
        options.headers!['Authorization'] = `Basic ${Buffer.from(this.config.authToken).toString('base64')}`
      }
    }

    const socket = new WebSocket(this.wsUrl, options)
    this.ws = socket

    socket.on('open', () => {
      if (this.closed || this.ws !== socket) {
        try {
          socket.close(1000, 'stale connection')
        } catch {
          // A stale socket has no transport authority.
        }
        return
      }

      this.retries = 0
      void this.reconcile()
    })

    socket.on('message', (data: RawData) => {
      if (this.closed || this.ws !== socket) {
        return
      }

      try {
        const raw: unknown = JSON.parse(data.toString())
        const event = IncusEventSchema.safeParse(raw)

        if (!event.success || event.data.type !== 'operation') {
          return
        }

        this.observe(event.data.metadata)
      } catch {
        console.warn('[IncusClient] Malformed event frame ignored; the stream remains active.')
      }
    })

    socket.on('error', error => {
      console.error('[IncusClient] Event stream error:', error.message)
    })

    socket.on('close', () => {
      if (this.ws === socket) {
        this.ws = null
      }

      if (!this.closed) {
        this.reconnect()
      }
    })
  }

  private reconnect(): void {
    if (this.closed || this.reconnectTimer) {
      return
    }

    const delay = Math.min(1_000 * Math.pow(2, this.retries), MAX_RECONNECT_DELAY_MS)
    this.retries++

    console.warn(`[IncusClient] Event stream disconnected. Reconnecting in ${delay}ms (attempt ${this.retries})...`)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  /**
   * Applies a positively observed Incus operation state.
   *
   * Nonterminal observations leave the operation pending. Terminal WebSocket
   * events and terminal HTTP probe responses use this same path.
   */
  private observe(metadata: unknown): void {
    const parsed = IncusOperationSchema.safeParse(metadata)

    if (!parsed.success) {
      return
    }

    const operation = parsed.data

    if (!INCUS_FINAL.has(operation.status_code)) {
      return
    }

    if (operation.status_code === 200) {
      this.settle(operation.id, {
        ok: true,
      })
      return
    }

    this.settle(operation.id, {
      ok: false,
      error: new IncusError(`Incus operation failed: ${operation.err ?? operation.status}`, 'API_ERROR', {
        operationId: operation.id,
        status: operation.status,
        code: operation.status_code,
        terminalProviderStateObserved: true,
      }),
    })
  }

  /**
   * Registers an operation immediately after its ID is extracted from the
   * asynchronous HTTP response.
   */
  private register(operationId: string, project: string | undefined, deadline: OperationDeadline): Promise<void> {
    this.assertDeadline(deadline)

    if (this.pending.has(operationId)) {
      throw new IncusError(`Incus operation '${operationId}' is already pending in this transport.`, 'CONFLICT', {
        operationId,
        path: deadline.path,
      })
    }

    const deadlineTimer = deadline.timer

    if (!deadlineTimer) {
      throw this.createDeadlineError(deadline.path, operationId)
    }

    deadline.operationId = operationId

    const completion = new Promise<void>((resolve, reject) => {
      const pending: PendingOperation = {
        resolve,
        reject,
        deadlineAt: deadline.deadlineAt,
        deadlineTimer,
        probeTimer: null,
        probeInFlight: false,
        settled: false,
        abortController: deadline.controller,
        ...(project === undefined ? {} : { project }),
      }

      this.pending.set(operationId, pending)
    })

    /**
     * The initial probe recovers a terminal result whose WebSocket event
     * arrived before local pending registration. Subsequent probes remain
     * available even while the event stream is disconnected.
     */
    this.scheduleProbe(operationId, 0)

    return completion
  }

  private scheduleProbe(operationId: string, delayMs = OPERATION_PROBE_INTERVAL_MS): void {
    const pending = this.pending.get(operationId)

    if (!pending || pending.settled || pending.probeTimer) {
      return
    }

    pending.probeTimer = setTimeout(() => {
      const current = this.pending.get(operationId)

      if (!current || current !== pending || current.settled) {
        return
      }

      current.probeTimer = null
      void this.probe(operationId)
    }, delayMs)
  }

  /**
   * Probes a registered operation over HTTP.
   *
   * Probe failures are retained as deadline diagnostics but do not settle the
   * provider operation. A transient probe failure is not proof of either
   * provider success or failure.
   */
  private async probe(operationId: string): Promise<void> {
    const pending = this.pending.get(operationId)

    if (!pending || pending.settled || pending.probeInFlight) {
      return
    }

    pending.probeInFlight = true

    try {
      const { data } = await this.request(`/operations/${encodeURIComponent(operationId)}`, 'GET', {
        project: pending.project,
        signal: pending.abortController.signal,
      })

      this.observe(data)
    } catch (error: unknown) {
      const current = this.pending.get(operationId)

      if (current === pending && !current.settled) {
        current.lastProbeError = messageFromUnknown(error)
      }
    } finally {
      const current = this.pending.get(operationId)

      if (current === pending && !current.settled) {
        current.probeInFlight = false
        this.scheduleProbe(operationId)
      }
    }
  }

  /**
   * Reconciles every currently registered operation when the event stream
   * reconnects.
   *
   * Reconciliation observes only operation IDs already returned by prior
   * mutations. It never discovers or adopts provider ownership.
   */
  private async reconcile(): Promise<void> {
    const operationIds = [...this.pending.keys()]

    if (operationIds.length === 0) {
      return
    }

    console.log(
      `[IncusClient] Reconciling ${operationIds.length} in-flight operation(s) after event-stream connection.`,
    )

    await Promise.allSettled(operationIds.map(operationId => this.probe(operationId)))
  }

  /**
   * Provides the only terminal settlement path for registered operations.
   */
  private settle(operationId: string, settlement: OperationSettlement): boolean {
    const pending = this.pending.get(operationId)

    if (!pending || pending.settled) {
      return false
    }

    pending.settled = true
    this.pending.delete(operationId)
    clearTimeout(pending.deadlineTimer)

    if (pending.probeTimer) {
      clearTimeout(pending.probeTimer)
      pending.probeTimer = null
    }

    if (!pending.abortController.signal.aborted) {
      pending.abortController.abort()
    }

    if (settlement.ok) {
      pending.resolve()
    } else {
      pending.reject(settlement.error)
    }

    return true
  }

  /**
   * Creates the one deadline that governs the complete provider-operation
   * lifecycle.
   */
  private createDeadline(path: string): OperationDeadline {
    const controller = new AbortController()
    const deadline: OperationDeadline = {
      path,
      deadlineAt: Date.now() + OPERATION_TIMEOUT_MS,
      controller,
      timer: null,
      operationId: null,
    }

    deadline.timer = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort()
      }

      const operationId = deadline.operationId

      if (!operationId) {
        return
      }

      const pending = this.pending.get(operationId)

      this.settle(operationId, {
        ok: false,
        error: this.createDeadlineError(path, operationId, pending?.lastProbeError),
      })
    }, OPERATION_TIMEOUT_MS)

    return deadline
  }

  private disposeDeadline(deadline: OperationDeadline): void {
    if (deadline.timer) {
      clearTimeout(deadline.timer)
      deadline.timer = null
    }
  }

  private assertDeadline(deadline: OperationDeadline): void {
    if (this.closed) {
      throw this.createShutdownError(deadline.operationId ?? undefined)
    }

    if (deadline.controller.signal.aborted || Date.now() >= deadline.deadlineAt) {
      throw this.createDeadlineError(deadline.path, deadline.operationId ?? undefined)
    }
  }

  private createSubmissionFailure(
    path: string,
    method: string,
    deadline: OperationDeadline,
    error: unknown,
  ): IncusError {
    if (this.closed) {
      return this.createShutdownError(deadline.operationId ?? undefined)
    }

    if (deadline.controller.signal.aborted || Date.now() >= deadline.deadlineAt) {
      return this.createDeadlineError(path, deadline.operationId ?? undefined)
    }

    return new IncusError(
      `Incus provider mutation submission failed: ${messageFromUnknown(error)}`,
      'TRANSPORT_ERROR',
      {
        path,
        method,
        operationId: deadline.operationId,
        uncertainProviderOutcome: true,
        error: detailsFromUnknown(error),
      },
    )
  }

  private createDeadlineError(path: string, operationId?: string, lastProbeError?: string): IncusError {
    const details: Record<string, unknown> = {
      path,
      operationId: operationId ?? null,
      timeoutMs: OPERATION_TIMEOUT_MS,
      uncertainProviderOutcome: true,
      terminalProviderStateObserved: false,
    }

    if (lastProbeError !== undefined) {
      details.lastProbeError = lastProbeError
    }

    return new IncusError(
      operationId
        ? `Incus operation '${operationId}' exceeded its overall deadline; the provider outcome is unknown.`
        : 'Incus provider mutation exceeded its overall deadline; the provider outcome is unknown.',
      'TRANSPORT_ERROR',
      details,
    )
  }

  private createShutdownError(operationId?: string): IncusError {
    return new IncusError(
      'Incus client is shutting down; the provider operation outcome may be unknown.',
      'TRANSPORT_ERROR',
      {
        operationId: operationId ?? null,
        uncertainProviderOutcome: true,
        transportShutdown: true,
      },
    )
  }

  /**
   * Builds common authentication, ETag, and caller-supplied headers.
   *
   * Content type is deliberately assigned by the JSON or raw request method so
   * file uploads cannot accidentally inherit `application/json`.
   */
  private buildHeaders(options?: IncusRequestOptions | IncusRawRequestOptions): Headers {
    const headers = new Headers()

    if (this.config.authToken) {
      headers.set('Authorization', `Basic ${Buffer.from(this.config.authToken).toString('base64')}`)
    }

    if (options?.etag) {
      headers.set('If-Match', options.etag)
    }

    if (options?.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        headers.set(key, value)
      }
    }

    return headers
  }

  /**
   * Injects project scope without allowing it to overwrite an explicit project
   * or all-projects query.
   */
  private applyQuery(path: string, options?: { project?: string }): string {
    const project = options?.project

    if (!project) {
      return path
    }

    const url = new URL(path, 'http://localhost')

    if (!url.searchParams.has('project') && !url.searchParams.has('all-projects')) {
      url.searchParams.set('project', project)
    }

    return `${url.pathname}${url.search}`
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new IncusError('Incus client is closed.', 'TRANSPORT_ERROR', {
        transportShutdown: true,
      })
    }
  }
}
