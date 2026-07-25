import fs from 'node:fs'
import { Agent, fetch, type Response } from 'undici'
import { IncusError } from '../../../errors'
import { detailsFromUnknown, messageFromUnknown } from './error'
import type { WorkerIncusConfig } from '../../../types'
import type { IncusMutationOptions, IncusRawMutationOptions, IncusRequestOptions } from '../types'
import type { IncusEndpoints } from './types'

const DEFAULT_CONNECTIONS = 100
const DEFAULT_PIPELINING = 10

/**
 * Resolves the shared HTTP and WebSocket endpoints for one Incus transport.
 *
 * A configured network URL takes precedence over the local Unix socket. The
 * runtime normally provides only one transport, but keeping precedence here
 * makes direct construction deterministic as well.
 */
export function resolveIncusEndpoints(config: WorkerIncusConfig): IncusEndpoints {
  if (config.url) {
    const url = config.url.replace(/\/+$/, '')
    return {
      baseUrl: `${url}/1.0`,
      eventUrl: `${url.replace(/^http/, 'ws')}/1.0/events?type=operation&all-projects=true`,
    }
  }
  if (config.socketPath) {
    return {
      baseUrl: 'http://localhost/1.0',
      eventUrl: `ws+unix://${config.socketPath}:/1.0/events?type=operation&all-projects=true`,
      socketPath: config.socketPath,
    }
  }
  throw new IncusError('Invalid Incus config: Must provide socketPath OR url', 'TRANSPORT_ERROR')
}

/**
 * Owns Incus HTTP endpoint, authentication, agent, and request mechanics.
 *
 * Response-envelope interpretation belongs to `response.ts`. Async operation
 * tracking and WebSocket lifecycle belong to their dedicated components.
 */
export class IncusHttp {
  private readonly agent: Agent
  private closed = false

  constructor(
    private readonly config: WorkerIncusConfig,
    public readonly endpoints: IncusEndpoints,
  ) {
    if (endpoints.socketPath) {
      this.agent = new Agent({
        connect: {
          socketPath: endpoints.socketPath,
        },
        connections: DEFAULT_CONNECTIONS,
        pipelining: DEFAULT_PIPELINING,
      })
      return
    }
    this.agent = new Agent({
      connect: {
        rejectUnauthorized: config.rejectUnauthorized ?? false,
        ...(config.cert && config.key
          ? {
              cert: config.cert,
              key: config.key,
            }
          : {}),
      },
      connections: DEFAULT_CONNECTIONS,
      pipelining: DEFAULT_PIPELINING,
    })
  }

  /**
   * Performs the local Unix-socket preflight.
   *
   * Network transport readiness remains asynchronous and is observed through
   * actual requests and the event-stream lifecycle.
   */
  public init(): void {
    this.assertOpen()
    const socketPath = this.endpoints.socketPath
    if (!socketPath) {
      return
    }
    try {
      fs.accessSync(socketPath, fs.constants.R_OK | fs.constants.W_OK)
    } catch {
      throw new IncusError(
        `Cannot access Incus socket at ${socketPath}. Ensure the Node.js process has correct permissions.`,
        'TRANSPORT_ERROR',
      )
    }
  }

  /**
   * Sends a request whose body, when present, is encoded as JSON.
   *
   * This method deliberately returns the raw response. Incus envelope parsing
   * and provider-outcome classification remain centralized in `response.ts`.
   */
  public async json(path: string, method: string, options?: IncusMutationOptions): Promise<Response> {
    this.assertOpen()
    const headers = this.headers(options)
    if (options?.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    const finalPath = this.query(path, options)
    try {
      return await fetch(`${this.endpoints.baseUrl}${finalPath}`, {
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
  }

  /**
   * Sends a raw byte request used by the Incus Files APIs.
   *
   * Raw requests must not inherit JSON content type. File uploads default to
   * `application/octet-stream` unless the caller supplied a more specific
   * type.
   */
  public async raw(path: string, method: string, options?: IncusRawMutationOptions): Promise<Response> {
    this.assertOpen()
    const headers = this.headers(options)
    if (options?.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/octet-stream')
    }
    const finalPath = this.query(path, options)
    try {
      return await fetch(`${this.endpoints.baseUrl}${finalPath}`, {
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
  }

  /**
   * Closes the shared HTTP agent.
   *
   * Active async operations and request abort controllers must be closed by the
   * operation tracker before this method is called.
   */
  public close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    try {
      void this.agent.destroy().catch((error: unknown) => {
        console.warn('[IncusHttp] Failed to destroy the Incus HTTP agent during shutdown.', error)
      })
    } catch (error: unknown) {
      console.warn('[IncusHttp] Failed to begin Incus HTTP agent shutdown.', error)
    }
  }

  private headers(options?: IncusRequestOptions): Headers {
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
   * Applies project scope without replacing project or all-projects query.
   */
  private query(path: string, options?: Pick<IncusRequestOptions, 'project'>): string {
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
