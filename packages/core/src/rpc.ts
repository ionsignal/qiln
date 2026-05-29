import { type ZodType, formatError, type output, type input } from 'zod'
import { GlobalError, GlobalErrorCode } from './errors'
import { UniversalSubjectParser } from './subjects'
import type { GlobalRpcResponse } from './schemas'

/**
 * Higher-order function to wrap global NATS RPC handlers with strict validation.
 *
 * It intercepts inbound NATS requests, parses them against the shared dictionary,
 * executes the domain logic, and maps any thrown errors into the standardized
 * `GlobalRpcResponse` envelope.
 *
 * @param inputSchema The Zod schema to validate the incoming NATS payload.
 * @param outputSchema The Zod schema to validate and strip the outgoing response payload.
 * @param handler The domain logic to execute if validation passes.
 * @returns An async function compatible with NatsBroker.serve()
 */
export function defineGlobalRpc<TInput extends ZodType<any, any, any>, TOutput extends ZodType<any, any, any>>(
  inputSchema: TInput,
  outputSchema: TOutput,
  handler: (input: output<TInput>, target: string, domain: string, action: string) => Promise<input<TOutput>>,
) {
  return async (subject: string, data: unknown): Promise<GlobalRpcResponse<output<TOutput>>> => {
    const parsedSubject = UniversalSubjectParser.parse(subject)
    if (!parsedSubject) {
      return {
        success: false,
        error: GlobalErrorCode.BAD_REQUEST,
        details: 'Global RPC handler received a malformed subject string.',
      }
    }
    const { target, domain, action } = parsedSubject
    try {
      const parsed = inputSchema.safeParse(data)
      if (!parsed.success) {
        return {
          success: false,
          error: GlobalErrorCode.BAD_REQUEST,
          details: formatError(parsed.error),
        }
      }
      const result = await handler(parsed.data, target, domain, action)
      const outputParsed = outputSchema.safeParse(result)
      if (!outputParsed.success) {
        console.error(`[Global RPC] Output validation failed for subject '${subject}':`, formatError(outputParsed.error))
        return {
          success: false,
          error: GlobalErrorCode.INTERNAL_ERROR,
          details: 'Output validation failed.',
        }
      }
      return {
        success: true,
        data: outputParsed.data,
      }
    } catch (error: unknown) {
      if (error instanceof GlobalError) {
        return {
          success: false,
          error: error.code,
          details: error.details || error.message,
        }
      }
      return {
        success: false,
        error: GlobalErrorCode.INTERNAL_ERROR,
        details: error instanceof Error ? error.message : 'Unknown execution error',
      }
    }
  }
}
