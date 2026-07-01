import { z } from 'zod'
import type { output, ZodType } from 'zod'
import type { Target, TargetTypeValue } from '../targets'

/**
 * A generic command acknowledgement for operations where success does not need
 * to return extra data. Business failures travel through the capsule bus error
 * envelope rather than through command output unions.
 */
export const CapsuleCommandAckSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict()

export type CapsuleCommandAck = z.infer<typeof CapsuleCommandAckSchema>

export interface CapsuleTargetPolicy<TPayload = unknown> {
  type: TargetTypeValue
  resolve(payload: TPayload): Target
}

export interface CapsuleCommandDefinition<
  TName extends string = string,
  TInputSchema extends ZodType = ZodType,
  TOutputSchema extends ZodType = ZodType,
> {
  kind: 'capsule.command'
  name: TName
  inputSchema: TInputSchema
  outputSchema: TOutputSchema
  timeoutMs: number
  target: CapsuleTargetPolicy<output<TInputSchema>>
}

export interface CapsuleEventDefinition<TName extends string = string, TEventSchema extends ZodType = ZodType> {
  kind: 'capsule.event'
  name: TName
  schema: TEventSchema
  target: CapsuleTargetPolicy<output<TEventSchema>>
}

export function defineCapsuleCommand<TName extends string, TInputSchema extends ZodType, TOutputSchema extends ZodType>(
  definition: CapsuleCommandDefinition<TName, TInputSchema, TOutputSchema>,
): CapsuleCommandDefinition<TName, TInputSchema, TOutputSchema> {
  return definition
}

export function defineCapsuleEvent<TName extends string, TEventSchema extends ZodType>(
  definition: CapsuleEventDefinition<TName, TEventSchema>,
): CapsuleEventDefinition<TName, TEventSchema> {
  return definition
}
