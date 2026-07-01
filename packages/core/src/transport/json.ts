import { NatsTransportError, NatsTransportErrorCode, transportDetailsFromUnknown } from './errors'
import type { Msg } from '@nats-io/transport-node'

export interface NatsJsonDecodeOptions {
  context?: string
  emptyFallback?: unknown
}

export type NatsJsonDecodeResult =
  | {
      ok: true
      data: unknown
    }
  | {
      ok: false
      error: NatsTransportError
    }

export function encodeJson(payload: unknown, context = 'NATS JSON payload'): string {
  try {
    const encoded = JSON.stringify(payload)
    if (encoded === undefined) {
      throw new Error(`${context} cannot be serialized to JSON.`)
    }
    return encoded
  } catch (error: unknown) {
    throw new NatsTransportError(`Failed to serialize ${context}.`, {
      code: NatsTransportErrorCode.SERIALIZATION_ERROR,
      details: transportDetailsFromUnknown(error),
    })
  }
}

export function decodeMessageJson(msg: Msg, options: NatsJsonDecodeOptions = {}): NatsJsonDecodeResult {
  const context = options.context ?? `NATS message on subject '${msg.subject}'`

  if (msg.data.length === 0) {
    return {
      ok: true,
      data: options.emptyFallback === undefined ? {} : options.emptyFallback,
    }
  }

  try {
    const data: unknown = msg.json()
    return {
      ok: true,
      data,
    }
  } catch (error: unknown) {
    return {
      ok: false,
      error: new NatsTransportError(`Failed to parse ${context} JSON.`, {
        code: NatsTransportErrorCode.PARSE_ERROR,
        details: {
          subject: msg.subject,
          error: transportDetailsFromUnknown(error),
        },
      }),
    }
  }
}
