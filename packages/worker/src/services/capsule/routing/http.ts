import { request } from 'undici'

export interface RoutingHttpRequest {
  url: string
  method: 'GET' | 'HEAD'
  expectedStatuses: readonly number[]
  virtualHost?: string
}

export type RoutingHttpResult =
  | { kind: 'success' }
  | { kind: 'unexpected_status'; status: number }
  | { kind: 'timeout'; error: unknown }
  | { kind: 'transport_failure'; error: unknown }

/**
 * Keeps the connection destination independent from the HTTP virtual host.
 *
 * Response content is not verification evidence and is discarded without
 * buffering or waiting for an application-controlled body to finish.
 */
export class RoutingHttpProbe {
  constructor(private readonly timeoutMs: number) {}

  public async request(input: RoutingHttpRequest): Promise<RoutingHttpResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
    }, this.timeoutMs)
    timeout.unref()
    try {
      const url = new URL(input.url)
      if (url.protocol !== 'http:') {
        throw new TypeError('Routing HTTP probes require an HTTP URL.')
      }
      // Request does not follow redirects by default. No redirect interceptor
      // is installed; redirect responses undergo ordinary status matching.
      const response = await request(url, {
        method: input.method,
        ...(input.virtualHost === undefined ? {} : { headers: { host: input.virtualHost } }),
        headersTimeout: 0,
        bodyTimeout: 0,
        signal: controller.signal,
      })
      // Intentional destruction of an unread body can emit a stream error.
      response.body.once('error', () => {})
      try {
        if (!input.expectedStatuses.includes(response.statusCode)) {
          return {
            kind: 'unexpected_status',
            status: response.statusCode,
          }
        }
        return {
          kind: 'success',
        }
      } finally {
        response.body.destroy()
      }
    } catch (error: unknown) {
      return {
        kind: controller.signal.aborted ? 'timeout' : 'transport_failure',
        error,
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}
