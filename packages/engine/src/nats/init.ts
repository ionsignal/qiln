import { type ZodType, formatError, type output, type input } from 'zod'
import { IncusError } from '../errors'
import { UniversalSubjectParser } from '@qiln/core/server'
import type { RpcResponse } from '../schemas/events'

/**
 * Higher-order function to wrap NATS RPC handlers with strict validation
 * and guaranteed response envelopes.
 *
 * This treats NATS as a transport layer, isolating domain logic from ingress routing,
 * and guarantees a response is sent to prevent requester starvation.
 *
 * @param inputSchema The Zod schema to validate the incoming NATS payload.
 * @param outputSchema The Zod schema to validate and strip the outgoing response payload.
 * @param handler The domain logic to execute if validation passes.
 * @returns An async function compatible with NatsBroker.serve()
 */
export function defineRpc<TInput extends ZodType<any, any, any>, TOutput extends ZodType<any, any, any>>(
  inputSchema: TInput,
  outputSchema: TOutput,
  handler: (input: output<TInput>, target: string) => Promise<input<TOutput>>,
) {
  return async (subject: string, data: unknown): Promise<RpcResponse<output<TOutput>>> => {
    const parsedSubject = UniversalSubjectParser.parse(subject)
    if (!parsedSubject) {
      return {
        success: false,
        error: 'BAD_SUBJECT',
        details: 'Unparseable subject string.',
      }
    }
    try {
      const parsed = inputSchema.safeParse(data)
      if (!parsed.success) {
        return {
          success: false,
          error: 'BAD_REQUEST',
          details: formatError(parsed.error),
        }
      }
      const result = await handler(parsed.data, parsedSubject.target)
      const outputParsed = outputSchema.safeParse(result)
      if (!outputParsed.success) {
        console.error(`[QilnEngine RPC] Output validation failed for subject '${subject}':`, formatError(outputParsed.error))
        return {
          success: false,
          error: 'INTERNAL_SERVER_ERROR',
          details: 'Output validation failed.',
        }
      }
      return {
        success: true,
        data: outputParsed.data,
      }
    } catch (error: unknown) {
      if (error instanceof IncusError) {
        return {
          success: false,
          error: error.code,
          details: error.message,
        }
      }
      return {
        success: false,
        error: 'INTERNAL_SERVER_ERROR',
        details: error instanceof Error ? error.message : 'Unknown execution error',
      }
    }
  }
}
