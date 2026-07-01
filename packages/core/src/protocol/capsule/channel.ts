import { z } from 'zod'
import { CapsuleCommandDefinitions, CapsuleEventDefinitions } from './messages'
import type { input, output } from 'zod'
import type { CapsuleCommandName, CapsuleEvent, CapsuleEventName } from './messages'
import type { Target } from './targets'

export const CapsuleChannelErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  TIMEOUT: 'TIMEOUT',
  TRANSPORT_ERROR: 'TRANSPORT_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const

export type CapsuleChannelErrorCode = (typeof CapsuleChannelErrorCode)[keyof typeof CapsuleChannelErrorCode]

export const CapsuleChannelErrorCodeValues = [
  CapsuleChannelErrorCode.BAD_REQUEST,
  CapsuleChannelErrorCode.UNAUTHORIZED,
  CapsuleChannelErrorCode.FORBIDDEN,
  CapsuleChannelErrorCode.NOT_FOUND,
  CapsuleChannelErrorCode.CONFLICT,
  CapsuleChannelErrorCode.TIMEOUT,
  CapsuleChannelErrorCode.TRANSPORT_ERROR,
  CapsuleChannelErrorCode.INTERNAL_ERROR,
] as const

export const CapsuleChannelErrorCodeSchema = z.enum(CapsuleChannelErrorCodeValues)

export interface CapsuleChannelErrorOptions {
  code: CapsuleChannelErrorCode
  details?: unknown
}

export class CapsuleChannelError extends Error {
  public readonly code: CapsuleChannelErrorCode
  public readonly details?: unknown

  constructor(message: string, options: CapsuleChannelErrorOptions) {
    super(message)
    this.name = 'CapsuleChannelError'
    this.code = options.code
    this.details = options.details
  }
}

export type CapsuleCommandInput<TName extends CapsuleCommandName> = input<(typeof CapsuleCommandDefinitions)[TName]['inputSchema']>
export type CapsuleCommandParsedInput<TName extends CapsuleCommandName> = output<(typeof CapsuleCommandDefinitions)[TName]['inputSchema']>
export type CapsuleCommandRawOutput<TName extends CapsuleCommandName> = input<(typeof CapsuleCommandDefinitions)[TName]['outputSchema']>
export type CapsuleCommandOutput<TName extends CapsuleCommandName> = output<(typeof CapsuleCommandDefinitions)[TName]['outputSchema']>

export type CapsuleEventInput<TName extends CapsuleEventName> = input<(typeof CapsuleEventDefinitions)[TName]['schema']>
export type CapsuleEventOutput<TName extends CapsuleEventName> = output<(typeof CapsuleEventDefinitions)[TName]['schema']>

export interface CapsuleCommandContext<TName extends CapsuleCommandName = CapsuleCommandName> {
  target: Target
  name: TName
}

export type CapsuleCommandHandler<TName extends CapsuleCommandName> = (
  inputValue: CapsuleCommandParsedInput<TName>,
  context: CapsuleCommandContext<TName>,
) => Promise<CapsuleCommandRawOutput<TName>> | CapsuleCommandRawOutput<TName>

export interface CapsuleCommandFailure {
  code: CapsuleChannelErrorCode
  message: string
  details?: unknown
}

export type CapsuleCommandErrorMapper = (error: unknown) => CapsuleCommandFailure

export interface CapsuleCommandHandlerOptions {
  queue?: string
  mapError?: CapsuleCommandErrorMapper
}

export interface CapsuleEventEnvelope<TEvent extends CapsuleEvent = CapsuleEvent> {
  target: Target
  event: TEvent
}

export type CapsuleEventFilter = (event: CapsuleEvent, envelope: CapsuleEventEnvelope) => boolean

export interface CapsuleChannel {
  start(): Promise<void>
  shutdown(): Promise<void>
  command<TName extends CapsuleCommandName>(name: TName, inputValue: CapsuleCommandInput<TName>): Promise<CapsuleCommandOutput<TName>>
  handle<TName extends CapsuleCommandName>(name: TName, handler: CapsuleCommandHandler<TName>, options?: CapsuleCommandHandlerOptions): void
  publish<TName extends CapsuleEventName>(name: TName, eventValue: CapsuleEventInput<TName>): Promise<void>
  subscribe(filter?: CapsuleEventFilter): AsyncIterable<CapsuleEventEnvelope>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function detailsFromUnknown(value: unknown): Record<string, unknown> | undefined {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    }
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

export function toCapsuleCommandFailure(error: unknown, fallbackMessage = 'Capsule command failed.'): CapsuleCommandFailure {
  if (error instanceof CapsuleChannelError) {
    if (error.details === undefined) {
      return {
        code: error.code,
        message: error.message,
      }
    }
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    }
  }
  const details = detailsFromUnknown(error)
  if (details === undefined) {
    return {
      code: CapsuleChannelErrorCode.INTERNAL_ERROR,
      message: fallbackMessage,
    }
  }
  return {
    code: CapsuleChannelErrorCode.INTERNAL_ERROR,
    message: fallbackMessage,
    details,
  }
}
