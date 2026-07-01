import { isTimeoutLike, NatsTransportError, NatsTransportErrorCode, transportDetailsFromUnknown } from './errors'
import { decodeMessageJson, encodeJson } from './json'
import type { NatsConnectionManager } from './connection'
import type { Msg } from '@nats-io/transport-node'

export interface NatsRequestJsonOptions {
  timeoutMs: number
  context?: string
  responseEmptyFallback?: unknown
}

export interface NatsPublishJsonOptions {
  context?: string
}

export interface NatsRespondJsonOptions {
  context?: string
  fallbackPayload?: unknown
}

export async function requestJson(
  manager: NatsConnectionManager,
  subject: string,
  payload: unknown,
  options: NatsRequestJsonOptions,
): Promise<unknown> {
  const nc = manager.requireConnection()
  const context = options.context ?? `NATS request '${subject}'`
  const encoded = encodeJson(payload, `${context} request`)
  let msg: Msg
  try {
    msg = await nc.request(subject, encoded, {
      timeout: options.timeoutMs,
    })
  } catch (error: unknown) {
    const timeout = isTimeoutLike(error)
    throw new NatsTransportError(timeout ? `${context} timed out.` : `Failed to send ${context}.`, {
      code: timeout ? NatsTransportErrorCode.TIMEOUT : NatsTransportErrorCode.REQUEST_ERROR,
      details: {
        subject,
        error: transportDetailsFromUnknown(error),
      },
    })
  }
  const decoded = decodeMessageJson(msg, {
    context: `${context} response`,
    emptyFallback: options.responseEmptyFallback === undefined ? {} : options.responseEmptyFallback,
  })
  if (!decoded.ok) {
    throw decoded.error
  }
  return decoded.data
}

export function publishJson(manager: NatsConnectionManager, subject: string, payload: unknown, options: NatsPublishJsonOptions = {}): void {
  const nc = manager.requireConnection()
  const context = options.context ?? `NATS publish '${subject}'`
  const encoded = encodeJson(payload, context)
  try {
    nc.publish(subject, encoded)
  } catch (error: unknown) {
    throw new NatsTransportError(`Failed to publish ${context}.`, {
      code: NatsTransportErrorCode.PUBLISH_ERROR,
      details: {
        subject,
        error: transportDetailsFromUnknown(error),
      },
    })
  }
}

export function respondJson(msg: Msg, payload: unknown, options: NatsRespondJsonOptions = {}): boolean {
  const context = options.context ?? `NATS response on subject '${msg.subject}'`
  try {
    const encoded = encodeJson(payload, context)
    return msg.respond(encoded)
  } catch (error: unknown) {
    if (options.fallbackPayload !== undefined) {
      try {
        const encodedFallback = encodeJson(options.fallbackPayload, `${context} fallback`)
        return msg.respond(encodedFallback)
      } catch (fallbackError: unknown) {
        throw new NatsTransportError(`Failed to send ${context} fallback response.`, {
          code: NatsTransportErrorCode.RESPOND_ERROR,
          details: {
            subject: msg.subject,
            originalError: transportDetailsFromUnknown(error),
            fallbackError: transportDetailsFromUnknown(fallbackError),
          },
        })
      }
    }
    throw new NatsTransportError(`Failed to send ${context}.`, {
      code: NatsTransportErrorCode.RESPOND_ERROR,
      details: {
        subject: msg.subject,
        error: transportDetailsFromUnknown(error),
      },
    })
  }
}
