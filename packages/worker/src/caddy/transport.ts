import { Agent, fetch, type Response } from 'undici'
import { CaddyError, CaddyErrorCode, CaddyMutationOutcome, caddyErrorDetailsFromUnknown } from './error'
import type { CaddyAdminEndpoint } from '../endpoint'
import type { CaddyConfigMutationMethod, CaddyHttpJsonResponse, CaddyHttpMutationResponse } from './types'

const DEFAULT_CONNECTIONS = 4
const DEFAULT_PIPELINING = 1
const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_ERROR_RESPONSE_BYTES = 16 * 1024
const MAX_ERROR_RESPONSE_PREVIEW_LENGTH = 4_096
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

interface CaddyHttpOptions {
  endpoint: CaddyAdminEndpoint
  timeoutMs: number
}

interface CaddyRequest {
  method: 'GET' | CaddyConfigMutationMethod
  path: string
  mutation: boolean
  body?: string
  ifMatch?: string
}

interface CaddyRawResponse {
  response: Response
  etag?: string
  complete: () => void
}

class ResponseBodyLimitError extends Error {
  constructor(limitBytes: number) {
    super(`Caddy admin response exceeded the ${limitBytes}-byte safety limit.`)
    this.name = 'ResponseBodyLimitError'
  }
}

function mergeChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const merged = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const body = response.body
  if (!body) {
    return ''
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) {
        break
      }
      const chunk = result.value
      if (!chunk) {
        continue
      }
      totalBytes += chunk.byteLength
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel()
        } catch {
          // The socket may already be closing after a provider-side failure.
        }
        throw new ResponseBodyLimitError(maxBytes)
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder().decode(mergeChunks(chunks, totalBytes))
}

async function cancelResponseBody(response: Response): Promise<void> {
  const body = response.body
  if (!body || body.locked) {
    return
  }
  try {
    await body.cancel()
  } catch {
    // The response may already be closing after an admin API transport failure.
  }
}

/**
 * Narrow Unix-socket or loopback-HTTP transport for the Caddy admin API.
 *
 * It deliberately has no retry path: a route operation must classify a failed
 * or interrupted configuration mutation from durable provider-intent evidence,
 * rather than transparently issuing another Caddy write.
 */
export class CaddyHttp {
  private readonly agent: Agent
  private closed = false

  constructor(private readonly options: CaddyHttpOptions) {
    this.agent =
      options.endpoint.transport === 'unix'
        ? new Agent({
            connect: {
              socketPath: options.endpoint.socketPath,
            },
            connections: DEFAULT_CONNECTIONS,
            pipelining: DEFAULT_PIPELINING,
          })
        : new Agent({
            connections: DEFAULT_CONNECTIONS,
            pipelining: DEFAULT_PIPELINING,
          })
  }

  public async getJson(path: string): Promise<CaddyHttpJsonResponse<unknown>> {
    const request: CaddyRequest = {
      method: 'GET',
      path,
      mutation: false,
    }
    const result = await this.request(request)
    try {
      await this.assertSuccessfulResponse(result.response, request)
      const text = await this.readSuccessfulJsonBody(result.response, request)
      let data: unknown
      try {
        data = JSON.parse(text)
      } catch (error: unknown) {
        throw new CaddyError(`Caddy admin GET '${path}' returned malformed JSON.`, {
          code: CaddyErrorCode.TRANSPORT_ERROR,
          outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
          details: {
            path,
            method: request.method,
            status: result.response.status,
            error: caddyErrorDetailsFromUnknown(error),
          },
        })
      }
      return {
        data,
        etag: result.etag,
        statusCode: result.response.status,
      }
    } finally {
      result.complete()
    }
  }

  public async putJson(path: string, value: unknown, ifMatch: string): Promise<CaddyHttpMutationResponse> {
    return await this.mutateJson('PUT', path, value, ifMatch)
  }

  public async patchJson(path: string, value: unknown, ifMatch: string): Promise<CaddyHttpMutationResponse> {
    return await this.mutateJson('PATCH', path, value, ifMatch)
  }

  public async delete(path: string, ifMatch: string): Promise<CaddyHttpMutationResponse> {
    return await this.mutateJson('DELETE', path, undefined, ifMatch)
  }

  public destroy(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    try {
      void this.agent.destroy().catch(() => {
        // A closed Unix socket is expected during process teardown.
      })
    } catch {
      // Agent destruction is best-effort because this client owns no recovery path.
    }
  }

  private async mutateJson(
    method: CaddyConfigMutationMethod,
    path: string,
    value: unknown,
    ifMatch: string,
  ): Promise<CaddyHttpMutationResponse> {
    this.assertIfMatch(ifMatch, path)

    const request: CaddyRequest = {
      method,
      path,
      mutation: true,
      ifMatch,
      ...(value === undefined
        ? {}
        : {
            body: this.encodeJson(value, path),
          }),
    }
    const result = await this.request(request)
    try {
      await this.assertSuccessfulResponse(result.response, request)
      await this.consumeSuccessfulMutationResponse(result.response, request)
      return {
        etag: result.etag,
        statusCode: result.response.status,
      }
    } finally {
      result.complete()
    }
  }

  private async request(request: CaddyRequest): Promise<CaddyRawResponse> {
    this.assertOpen()
    this.assertAdminPath(request.path)

    const headers = new Headers({
      Accept: 'application/json',
    })
    if (request.body !== undefined) {
      headers.set('Content-Type', 'application/json')
    }
    if (request.ifMatch !== undefined) {
      headers.set('If-Match', request.ifMatch)
    }
    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.options.timeoutMs)
    timeout.unref()
    try {
      const response = await fetch(this.requestUrl(request.path), {
        method: request.method,
        dispatcher: this.agent,
        headers,
        body: request.body,
        signal: controller.signal,
        redirect: 'manual',
      })
      return {
        response,
        etag: response.headers.get('etag') ?? undefined,
        complete: () => {
          clearTimeout(timeout)
        },
      }
    } catch (error: unknown) {
      clearTimeout(timeout)
      throw new CaddyError(`Caddy admin ${request.method} '${request.path}' request failed.`, {
        code: CaddyErrorCode.TRANSPORT_ERROR,
        outcome: request.mutation ? CaddyMutationOutcome.UNKNOWN : CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          path: request.path,
          method: request.method,
          timedOut,
          error: caddyErrorDetailsFromUnknown(error),
        },
      })
    }
  }

  private async assertSuccessfulResponse(response: Response, request: CaddyRequest): Promise<void> {
    if (response.ok) {
      return
    }
    const diagnostics = await this.readErrorDiagnostics(response)
    const status = response.status
    const rejectedOutcome = request.mutation
      ? CaddyMutationOutcome.CONFIRMED_REJECTED
      : CaddyMutationOutcome.NOT_ATTEMPTED
    if (status === 412) {
      throw new CaddyError(`Caddy admin ${request.method} '${request.path}' rejected the stale ETag precondition.`, {
        code: CaddyErrorCode.CONFLICT,
        outcome: CaddyMutationOutcome.CONFIRMED_NOT_APPLIED,
        details: {
          path: request.path,
          method: request.method,
          status,
          ...diagnostics,
        },
      })
    }
    if (status === 404) {
      throw new CaddyError(
        `Caddy admin ${request.method} '${request.path}' did not find the requested configuration scope.`,
        {
          code: CaddyErrorCode.NOT_FOUND,
          outcome: rejectedOutcome,
          details: {
            path: request.path,
            method: request.method,
            status,
            ...diagnostics,
          },
        },
      )
    }
    if (status === 409) {
      throw new CaddyError(`Caddy admin ${request.method} '${request.path}' reported a configuration conflict.`, {
        code: CaddyErrorCode.CONFLICT,
        outcome: rejectedOutcome,
        details: {
          path: request.path,
          method: request.method,
          status,
          ...diagnostics,
        },
      })
    }

    if (status >= 400 && status < 500) {
      throw new CaddyError(`Caddy admin ${request.method} '${request.path}' rejected the request.`, {
        code: CaddyErrorCode.API_ERROR,
        outcome: rejectedOutcome,
        details: {
          path: request.path,
          method: request.method,
          status,
          ...diagnostics,
        },
      })
    }
    throw new CaddyError(`Caddy admin ${request.method} '${request.path}' returned an ambiguous response.`, {
      code: CaddyErrorCode.TRANSPORT_ERROR,
      outcome: request.mutation ? CaddyMutationOutcome.UNKNOWN : CaddyMutationOutcome.NOT_ATTEMPTED,
      details: {
        path: request.path,
        method: request.method,
        status,
        ...diagnostics,
      },
    })
  }

  private async readSuccessfulJsonBody(response: Response, request: CaddyRequest): Promise<string> {
    let text: string
    try {
      text = await readResponseText(response, MAX_JSON_RESPONSE_BYTES)
    } catch (error: unknown) {
      throw new CaddyError(`Failed to read Caddy admin ${request.method} '${request.path}' JSON response.`, {
        code: CaddyErrorCode.TRANSPORT_ERROR,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          path: request.path,
          method: request.method,
          status: response.status,
          error: caddyErrorDetailsFromUnknown(error),
        },
      })
    }
    if (text.trim() === '') {
      throw new CaddyError(`Caddy admin ${request.method} '${request.path}' returned an empty JSON response.`, {
        code: CaddyErrorCode.TRANSPORT_ERROR,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          path: request.path,
          method: request.method,
          status: response.status,
        },
      })
    }
    return text
  }

  private async consumeSuccessfulMutationResponse(response: Response, request: CaddyRequest): Promise<void> {
    try {
      await readResponseText(response, MAX_ERROR_RESPONSE_BYTES)
    } catch (error: unknown) {
      await cancelResponseBody(response)
      throw new CaddyError(
        `Failed to read Caddy admin ${request.method} '${request.path}' mutation response before the request deadline.`,
        {
          code: CaddyErrorCode.TRANSPORT_ERROR,
          outcome: CaddyMutationOutcome.UNKNOWN,
          details: {
            path: request.path,
            method: request.method,
            status: response.status,
            error: caddyErrorDetailsFromUnknown(error),
          },
        },
      )
    }
  }

  private async readErrorDiagnostics(response: Response): Promise<Record<string, unknown>> {
    try {
      const body = await readResponseText(response, MAX_ERROR_RESPONSE_BYTES)
      if (body === '') {
        return {}
      }
      return {
        responseBody: body.slice(0, MAX_ERROR_RESPONSE_PREVIEW_LENGTH),
      }
    } catch (error: unknown) {
      return {
        responseBodyReadError: caddyErrorDetailsFromUnknown(error),
      }
    }
  }

  private encodeJson(value: unknown, path: string): string {
    try {
      const encoded = JSON.stringify(value)
      if (encoded === undefined) {
        throw new Error('Value cannot be serialized to JSON.')
      }
      return encoded
    } catch (error: unknown) {
      throw new CaddyError(`Failed to serialize Caddy configuration for '${path}'.`, {
        code: CaddyErrorCode.VALIDATION_ERROR,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          path,
          error: caddyErrorDetailsFromUnknown(error),
        },
      })
    }
  }

  private requestUrl(path: string): string {
    return this.options.endpoint.transport === 'unix'
      ? `http://localhost${path}`
      : `${this.options.endpoint.baseUrl}${path}`
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new CaddyError('Caddy admin client is closed.', {
        code: CaddyErrorCode.TRANSPORT_ERROR,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          transportShutdown: true,
        },
      })
    }
  }

  private assertAdminPath(path: string): void {
    if (
      !path.startsWith('/') ||
      path.trim() !== path ||
      path.includes('?') ||
      path.includes('#') ||
      CONTROL_CHARACTER_PATTERN.test(path)
    ) {
      throw new CaddyError('Caddy admin request path is invalid.', {
        code: CaddyErrorCode.VALIDATION_ERROR,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          path,
        },
      })
    }
  }

  private assertIfMatch(ifMatch: string, path: string): void {
    if (ifMatch.trim() === '' || CONTROL_CHARACTER_PATTERN.test(ifMatch)) {
      throw new CaddyError('Caddy conditional mutation requires a valid route-array ETag.', {
        code: CaddyErrorCode.VALIDATION_ERROR,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          path,
        },
      })
    }
  }
}
