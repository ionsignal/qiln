import { IncusError } from '../../../errors'
import { IncusResponseSchema, type IncusResponse } from '../schemas/response'
import { detailsFromUnknown } from './error'
import type { Response } from 'undici'

export interface IncusParsedResponse {
  envelope: IncusResponse
  etag?: string
}

export interface IncusResponseParseOptions {
  path: string
  method: string

  /**
   * Marks malformed or unsupported response evidence as an uncertain provider
   * mutation outcome.
   *
   * Only a valid Incus error envelope is positively observed terminal provider
   * failure evidence. HTTP status alone does not prove a mutation was rejected
   * before it took effect.
   */
  mutation?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function providerErrorCode(code: number): IncusError['code'] {
  if (code === 404) {
    return 'NOT_FOUND'
  }
  if (code === 401 || code === 403) {
    return 'FORBIDDEN'
  }
  if (code === 409) {
    return 'CONFLICT'
  }
  return 'API_ERROR'
}

function parseFailureDetails(
  response: Response,
  options: IncusResponseParseOptions,
  error: unknown,
): Record<string, unknown> {
  return {
    path: options.path,
    method: options.method,
    status: response.status,
    uncertainProviderOutcome: options.mutation === true,
    terminalProviderStateObserved: false,
    error: detailsFromUnknown(error),
  }
}

function unexpectedStatusDetails(
  response: Response,
  options: IncusResponseParseOptions,
  envelopeType?: IncusResponse['type'],
): Record<string, unknown> {
  return {
    path: options.path,
    method: options.method,
    status: response.status,
    envelopeType: envelopeType ?? null,
    uncertainProviderOutcome: options.mutation === true,
    terminalProviderStateObserved: false,
  }
}

function readHttpError(response: Response, options: IncusResponseParseOptions, message?: string): IncusError {
  return new IncusError(
    message ?? `Incus request failed with HTTP status ${response.status}.`,
    providerErrorCode(response.status),
    {
      ...unexpectedStatusDetails(response, options),
      uncertainProviderOutcome: false,
    },
  )
}

/**
 * Returns true only when an Incus error contains positive evidence that the
 * provider reached a terminal failure state.
 *
 * Mutation callers must not infer certainty from the error class or code. A
 * validation, conflict, authorization, or API error may still originate from a
 * malformed or otherwise ambiguous mutation response.
 */
export function isObservedTerminalProviderFailure(error: unknown): error is IncusError {
  if (!(error instanceof IncusError) || !isRecord(error.details)) {
    return false
  }
  return error.details.terminalProviderStateObserved === true && error.details.uncertainProviderOutcome === false
}

/**
 * Parses and validates one Incus universal response envelope.
 *
 * `sync` and `async` envelopes are accepted only on successful HTTP responses.
 * A valid Incus `error` envelope remains a positively observed terminal
 * provider failure regardless of HTTP status.
 *
 * A malformed or non-Incus mutation response never becomes definite provider
 * failure evidence. It is marked uncertain and normalized by the transport
 * mutation boundary.
 */
export async function parseIncusResponse(
  response: Response,
  options: IncusResponseParseOptions,
): Promise<IncusParsedResponse> {
  let raw: unknown
  try {
    raw = await response.json()
  } catch (error: unknown) {
    if (!response.ok && options.mutation !== true) {
      throw readHttpError(response, options)
    }
    throw new IncusError('Failed to parse Incus response JSON.', 'VALIDATION_ERROR', {
      ...parseFailureDetails(response, options, error),
    })
  }
  const envelope = IncusResponseSchema.safeParse(raw)
  if (!envelope.success) {
    if (!response.ok && options.mutation !== true) {
      throw readHttpError(response, options)
    }
    throw new IncusError('Malformed Incus Response Envelope', 'VALIDATION_ERROR', {
      path: options.path,
      method: options.method,
      status: response.status,
      validation: envelope.error.format(),
      uncertainProviderOutcome: options.mutation === true,
      terminalProviderStateObserved: false,
    })
  }
  if (envelope.data.type !== 'error' && !response.ok) {
    if (options.mutation !== true) {
      throw readHttpError(
        response,
        options,
        `Incus returned a '${envelope.data.type}' envelope with non-success HTTP status ${response.status}.`,
      )
    }
    throw new IncusError(
      `Incus returned a '${envelope.data.type}' envelope with non-success HTTP status ${response.status}.`,
      'VALIDATION_ERROR',
      unexpectedStatusDetails(response, options, envelope.data.type),
    )
  }
  return {
    envelope: envelope.data,
    etag: response.headers.get('etag') ?? undefined,
  }
}

/**
 * Returns synchronous Incus response metadata or throws a classified provider
 * error.
 *
 * A valid Incus error envelope is positively observed terminal provider failure
 * evidence. An async envelope is not accepted by a synchronous request
 * boundary.
 */
export function data(
  parsed: IncusParsedResponse,
  options: {
    path: string
    method: string
    mutation?: boolean
  },
): {
  data: unknown
  etag?: string
} {
  const envelope = parsed.envelope
  if (envelope.type === 'error') {
    throw providerError(envelope.error, envelope.error_code, options)
  }
  if (envelope.type === 'async') {
    throw new IncusError('Expected sync response, got async operation', 'API_ERROR', {
      path: options.path,
      method: options.method,
      operationId: envelope.metadata.id,
      terminalProviderStateObserved: false,
      uncertainProviderOutcome: options.mutation === true,
    })
  }
  return {
    data: envelope.metadata,
    etag: parsed.etag,
  }
}

/**
 * Returns a successfully accepted async operation ID or indicates that Incus
 * completed the mutation synchronously.
 */
export function operation(
  parsed: IncusParsedResponse,
  options: {
    path: string
    method: string
  },
):
  | {
      kind: 'sync'
    }
  | {
      kind: 'async'
      operationId: string
    } {
  const envelope = parsed.envelope
  if (envelope.type === 'error') {
    throw providerError(envelope.error, envelope.error_code, {
      ...options,
      mutation: true,
    })
  }
  if (envelope.type === 'sync') {
    return {
      kind: 'sync',
    }
  }
  return {
    kind: 'async',
    operationId: envelope.metadata.id,
  }
}

/**
 * Converts a non-successful raw read response into the same provider error
 * vocabulary used by JSON reads.
 *
 * This function is deliberately read-only. Raw mutations must pass through
 * `parseIncusResponse()` with mutation context so malformed, non-Incus, or
 * otherwise ambiguous responses fail closed.
 */
export async function readError(response: Response, path: string, method: string): Promise<IncusError> {
  let message = `HTTP Error ${response.status}`
  let errorCode = response.status
  let observedIncusError = false
  const text = await response.text().catch(() => '')
  if (text) {
    try {
      const raw: unknown = JSON.parse(text)
      const envelope = IncusResponseSchema.safeParse(raw)
      if (envelope.success && envelope.data.type === 'error') {
        message = envelope.data.error
        errorCode = envelope.data.error_code
        observedIncusError = true
      } else {
        message = text
      }
    } catch {
      message = text
    }
  }
  if (observedIncusError) {
    return providerError(message, errorCode, {
      path,
      method,
    })
  }
  return new IncusError(message, providerErrorCode(errorCode), {
    path,
    method,
    code: errorCode,
    terminalProviderStateObserved: false,
    uncertainProviderOutcome: false,
  })
}

function providerError(
  message: string,
  code: number,
  options: {
    path: string
    method: string
    mutation?: boolean
  },
): IncusError {
  return new IncusError(message, providerErrorCode(code), {
    path: options.path,
    method: options.method,
    code,
    terminalProviderStateObserved: true,
    uncertainProviderOutcome: false,
  })
}
