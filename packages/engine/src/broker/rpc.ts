import { BaseRpcResponseSchema } from '../schemas/events'
import { IncusError } from '../errors'
import type { ZodType, output } from 'zod'
import type { BaseConnectionManager } from '@qiln/core/server'

/**
 * Handles Request/Reply patterns for JIT queries and cross-module decoupling.
 */
export class RpcManager {
  constructor(private readonly connection: BaseConnectionManager) {}

  /**
   * Request method for issuing JIT queries over NATS.
   * Utilizes Two-Step Parsing to bypass generic erasure and enforce strict E2E type safety.
   */
  async request<TOutput extends ZodType>(
    subject: string,
    payload: unknown,
    responseSchema: TOutput,
    timeoutMs = 5000,
  ): Promise<output<TOutput>> {
    if (!this.connection.nc) {
      throw new Error('[QilnEngine Broker] FATAL: request() called before start().')
    }
    try {
      const msg = await this.connection.nc.request(subject, JSON.stringify(payload), { timeout: timeoutMs })
      let rawData: unknown
      try {
        rawData = msg.json()
      } catch (parseErr) {
        throw new IncusError(`Failed to parse NATS response as JSON on subject '${subject}'`, 'API_ERROR')
      }
      const envelopeParsed = BaseRpcResponseSchema.safeParse(rawData)
      if (!envelopeParsed.success) {
        throw new IncusError(`Malformed RPC envelope received on subject '${subject}'`, 'API_ERROR')
      }
      const envelope = envelopeParsed.data
      if (!envelope.success) {
        throw new IncusError(envelope.error, 'API_ERROR', envelope.details as Record<string, any>)
      }
      const domainParsed = responseSchema.safeParse(envelope.data)
      if (!domainParsed.success) {
        throw new IncusError(`RPC Domain validation failed on subject '${subject}'`, 'VALIDATION_ERROR')
      }
      return domainParsed.data
    } catch (error) {
      console.error(`[QilnEngine Broker] request() failed for subject '${subject}':`, error)
      throw error
    }
  }

  /**
   * Registers a NATS request/reply responder.
   */
  serve(subject: string, handler: (subject: string, data: unknown) => Promise<unknown>, opts?: { queue?: string }): void {
    if (!this.connection.nc) {
      // Fail-Fast: Enforce temporal coupling (start must precede serve)
      throw new Error(`[QilnEngine Broker] FATAL: serve() called before start(). Subject '${subject}' cannot be registered.`)
    }
    const queue = opts?.queue !== undefined ? opts.queue : 'qiln-engine-workers'
    const sub = this.connection.nc.subscribe(subject, queue ? { queue } : undefined)
    void (async () => {
      for await (const msg of sub) {
        if (!msg.reply) continue
        try {
          let data: unknown = {}
          try {
            data = msg.data.length > 0 ? msg.json() : {}
          } catch (parseErr) {
            console.warn(`[QilnEngine Broker] serve() failed to parse JSON payload on subject '${msg.subject}':`, parseErr)
            msg.respond(JSON.stringify({ success: false, error: 'BAD_PAYLOAD' }))
            continue
          }
          const result = await handler(msg.subject, data)
          try {
            msg.respond(JSON.stringify(result))
          } catch (transportErr) {
            console.error(`[QilnEngine Broker] serve() failed to serialize/send response on subject '${msg.subject}':`, transportErr)
          }
        } catch (err) {
          console.error(`[QilnEngine Broker] serve() handler error for subject '${msg.subject}':`, err)
          try {
            msg.respond(
              JSON.stringify({
                success: false,
                error: 'INTERNAL_BROKER_ERROR',
                details: err instanceof Error ? err.message : 'Unknown internal error',
              }),
            )
          } catch (fallbackErr) {
            console.error(`[QilnEngine Broker] serve() catastrophic failure sending fallback error:`, fallbackErr)
          }
        }
      }
    })()
  }
}
