const DEFAULT_TIMEOUT_TEXT = 'timeout'

export const NatsTransportErrorCode = {
  NOT_STARTED: 'NOT_STARTED',
  TIMEOUT: 'TIMEOUT',
  SERIALIZATION_ERROR: 'SERIALIZATION_ERROR',
  PARSE_ERROR: 'PARSE_ERROR',
  REQUEST_ERROR: 'REQUEST_ERROR',
  PUBLISH_ERROR: 'PUBLISH_ERROR',
  RESPOND_ERROR: 'RESPOND_ERROR',
  SUBSCRIPTION_ERROR: 'SUBSCRIPTION_ERROR',
  SHUTDOWN_ERROR: 'SHUTDOWN_ERROR',
} as const

export type NatsTransportErrorCode = (typeof NatsTransportErrorCode)[keyof typeof NatsTransportErrorCode]

export interface NatsTransportErrorOptions {
  code: NatsTransportErrorCode
  details?: unknown
}

export class NatsTransportError extends Error {
  public readonly code: NatsTransportErrorCode
  public readonly details?: unknown

  constructor(message: string, options: NatsTransportErrorOptions) {
    super(message)
    this.name = 'NatsTransportError'
    this.code = options.code
    this.details = options.details
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasStringCode(value: unknown): value is { code: string } {
  return isRecord(value) && typeof value.code === 'string'
}

export function isNatsTransportError(value: unknown): value is NatsTransportError {
  return value instanceof NatsTransportError
}

export function transportDetailsFromUnknown(value: unknown): Record<string, unknown> | undefined {
  if (value instanceof NatsTransportError) {
    const details: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      code: value.code,
    }
    if (value.details !== undefined) {
      details.details = value.details
    }
    return details
  }
  if (value instanceof Error) {
    const details: Record<string, unknown> = {
      name: value.name,
      message: value.message,
    }
    if (hasStringCode(value)) {
      details.code = value.code
    }
    return details
  }
  if (isRecord(value)) {
    return value
  }
  if (value === undefined || value === null) {
    return undefined
  }
  return {
    value,
  }
}

export function isTimeoutLike(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const name = error.name.toLowerCase()
  const message = error.message.toLowerCase()
  const code = hasStringCode(error) ? error.code.toLowerCase() : ''
  return name.includes(DEFAULT_TIMEOUT_TEXT) || message.includes(DEFAULT_TIMEOUT_TEXT) || code.includes(DEFAULT_TIMEOUT_TEXT)
}
