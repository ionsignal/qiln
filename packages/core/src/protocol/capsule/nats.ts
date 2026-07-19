import { z } from 'zod'
import {
  decodeMessageJson,
  isNatsTransportError,
  NatsConnectionManager,
  NatsTransportError,
  NatsTransportErrorCode,
  publishJson,
  requestJson,
  respondJson as respondNatsJson,
} from '../../transport'
import {
  CapsuleEventSchema,
  getCapsuleCommandDefinition,
  getCapsuleEventDefinition,
  type CapsuleCommandDefinitionFor,
  type CapsuleCommandName,
  type CapsuleEventDefinitionFor,
  type CapsuleEventName,
} from './messages'
import {
  CapsuleChannelError,
  CapsuleChannelErrorCode,
  detailsFromUnknown,
  toCapsuleCommandFailure,
  type CapsuleChannel,
  type CapsuleCommandHandler,
  type CapsuleCommandHandlerOptions,
  type CapsuleCommandInput,
  type CapsuleCommandOutput,
  type CapsuleCommandParsedInput,
  type CapsuleEventEnvelope,
  type CapsuleEventFilter,
  type CapsuleEventInput,
  type CapsuleEventOutput,
} from './channel'
import {
  CapsuleRpcEnvelopeSchema,
  createCapsuleRpcFailureEnvelope,
  createCapsuleRpcSuccessEnvelope,
  type CapsuleRpcEnvelope,
  type CapsuleRpcFailureEnvelope,
} from './envelopes'
import {
  buildCapsuleCommandHandlerSubject,
  buildCapsuleCommandSubject,
  buildCapsuleEventSubject,
  buildCapsuleEventSubscriptionSubject,
  parseCapsuleSubject,
  CapsuleSubjectKind,
} from './subjects'
import { TargetSchema, isTargetEqual, type Target, type TargetTypeValue } from './targets'
import type { Msg, Subscription } from '@nats-io/transport-node'

const DEFAULT_COMMAND_QUEUE = 'qiln-capsule-workers'
const DEFAULT_LOGGER_PREFIX = '[CapsuleNatsChannel]'

export interface CapsuleNatsChannelConfig {
  servers: string | string[]
  token?: string
}

export interface CapsuleNatsChannelOptions {
  loggerPrefix?: string
  commandQueue?: string
}

interface CapsuleTargetedDefinition {
  name: string
  target: {
    type: TargetTypeValue
    resolve(payload: unknown): Target
  }
}

interface ZodErrorLike {
  issues: readonly z.core.$ZodIssue[]
}

type ParseResult<TData> =
  | {
      ok: true
      data: TData
    }
  | {
      ok: false
      details: Record<string, unknown>
    }

function issuePathToJson(path: readonly PropertyKey[]): Array<string | number> {
  return path.map(segment => {
    if (typeof segment === 'symbol') {
      return segment.toString()
    }
    return segment
  })
}

function validationDetails(error: ZodErrorLike): Record<string, unknown> {
  return {
    validation: {
      issues: error.issues.map(issue => ({
        code: issue.code,
        path: issuePathToJson(issue.path),
        message: issue.message,
      })),
    },
  }
}

/**
 * Server-side NATS implementation of the capsule operation channel.
 *
 * Product code should not construct subjects or transport envelopes directly.
 *
 * This class owns the capsule subject family, request/reply envelope, validation, and target checks for
 * capsule branch commands/events. Raw NATS plumbing lives in `transport/nats` so future protocol adapters
 * can reuse connection mechanics without inheriting capsule semantics.
 */
export class CapsuleNatsChannel implements CapsuleChannel {
  private readonly connection: NatsConnectionManager
  private readonly loggerPrefix: string
  private readonly commands: string

  /*
   * TODO: Capsule targets validate routing and payload/subject consistency, but they do not authenticate
   * the command publisher. Qiln currently treats NATS as a private, trusted control plane, and all NATS
   * publishers are equivalently privileged to assert owner targets and operation actor provenance.
   *
   * After MVP, we will enforce producer identity and subject-level publish permissions, then bind Worker
   * authorization to that authenticated producer identity rather than trusting `input.target` and
   * `input.actor` assertions alone.
   */
  constructor(config: CapsuleNatsChannelConfig, options: CapsuleNatsChannelOptions = {}) {
    this.loggerPrefix = options.loggerPrefix ?? DEFAULT_LOGGER_PREFIX
    this.commands = options.commandQueue ?? DEFAULT_COMMAND_QUEUE
    this.connection = new NatsConnectionManager(config, {
      loggerPrefix: this.loggerPrefix,
    })
  }

  async start(): Promise<void> {
    await this.connection.start()
  }

  async shutdown(): Promise<void> {
    await this.connection.shutdown()
  }

  handle<TName extends CapsuleCommandName>(
    name: TName,
    handler: CapsuleCommandHandler<TName>,
    options: CapsuleCommandHandlerOptions = {},
  ): void {
    const definition = getCapsuleCommandDefinition(name)
    const subject = buildCapsuleCommandHandlerSubject(definition.target.type, name)
    const queue = options.queue ?? this.commands
    const sub = queue ? this.connection.subscribe(subject, { queue }) : this.connection.subscribe(subject)
    void this.runCommandResponder(sub, name, handler, options)
  }

  async command<TName extends CapsuleCommandName>(name: TName, inputValue: CapsuleCommandInput<TName>): Promise<CapsuleCommandOutput<TName>> {
    const definition = getCapsuleCommandDefinition(name)
    const parsedInput = this.safeParseCommandInput(definition, inputValue)
    if (!parsedInput.ok) {
      throw new CapsuleChannelError(`Invalid input for capsule command '${name}'.`, {
        code: CapsuleChannelErrorCode.BAD_REQUEST,
        details: parsedInput.details,
      })
    }
    const resolvedTarget = this.safeResolveDefinitionTarget(definition, parsedInput.data)
    if (!resolvedTarget.ok) {
      throw new CapsuleChannelError(`Invalid target for capsule command '${name}'.`, {
        code: CapsuleChannelErrorCode.BAD_REQUEST,
        details: resolvedTarget.details,
      })
    }
    const subject = buildCapsuleCommandSubject(resolvedTarget.data, name)
    let rawEnvelope: unknown
    try {
      rawEnvelope = await requestJson(this.connection, subject, parsedInput.data, {
        timeoutMs: definition.timeoutMs,
        context: `capsule command '${name}'`,
        responseEmptyFallback: {},
      })
    } catch (error: unknown) {
      throw this.toCapsuleCommandTransportError(name, error)
    }
    const parsedEnvelope = this.safeParseRpcEnvelope(rawEnvelope)
    if (!parsedEnvelope.ok) {
      throw new CapsuleChannelError(`Malformed capsule command '${name}' response envelope.`, {
        code: CapsuleChannelErrorCode.INTERNAL_ERROR,
        details: parsedEnvelope.details,
      })
    }
    const envelope = parsedEnvelope.data
    if (!envelope.success) {
      throw new CapsuleChannelError(envelope.message, {
        code: envelope.code,
        details: envelope.details,
      })
    }
    const parsedOutput = this.safeParseCommandOutput(definition, envelope.data)
    if (!parsedOutput.ok) {
      throw new CapsuleChannelError(`Invalid output for capsule command '${name}'.`, {
        code: CapsuleChannelErrorCode.INTERNAL_ERROR,
        details: parsedOutput.details,
      })
    }
    return parsedOutput.data
  }

  async publish<TName extends CapsuleEventName>(name: TName, eventValue: CapsuleEventInput<TName>): Promise<void> {
    const definition = getCapsuleEventDefinition(name)
    const parsedEvent = this.safeParseEventInput(definition, eventValue)
    if (!parsedEvent.ok) {
      throw new CapsuleChannelError(`Invalid payload for capsule event '${name}'.`, {
        code: CapsuleChannelErrorCode.BAD_REQUEST,
        details: parsedEvent.details,
      })
    }
    if (parsedEvent.data.type !== name) {
      throw new CapsuleChannelError(`Capsule event payload type does not match event '${name}'.`, {
        code: CapsuleChannelErrorCode.BAD_REQUEST,
        details: {
          payloadType: parsedEvent.data.type,
          expectedType: name,
        },
      })
    }
    const resolvedTarget = this.safeResolveDefinitionTarget(definition, parsedEvent.data)
    if (!resolvedTarget.ok) {
      throw new CapsuleChannelError(`Invalid target for capsule event '${name}'.`, {
        code: CapsuleChannelErrorCode.BAD_REQUEST,
        details: resolvedTarget.details,
      })
    }
    const subject = buildCapsuleEventSubject(resolvedTarget.data, name)
    try {
      publishJson(this.connection, subject, parsedEvent.data, {
        context: `capsule event '${name}'`,
      })
    } catch (error: unknown) {
      throw this.toCapsulePublishTransportError(name, error)
    }
  }

  async *subscribe(filter: CapsuleEventFilter = () => true): AsyncIterable<CapsuleEventEnvelope> {
    const sub = this.connection.subscribe(buildCapsuleEventSubscriptionSubject())
    const shutdownSignal = this.connection.signal
    try {
      for await (const msg of sub) {
        if (shutdownSignal.aborted) {
          break
        }
        const envelope = this.decodeEventMessage(msg)
        if (!envelope) {
          continue
        }
        let accepted = false
        try {
          accepted = filter(envelope.event, envelope)
        } catch (error: unknown) {
          console.warn(`${this.loggerPrefix} Event filter rejected with an error. Dropping event.`, error)
          continue
        }
        if (accepted) {
          yield envelope
        }
      }
    } catch (error: unknown) {
      if (!(error instanceof Error && error.name === 'AbortError') && !shutdownSignal.aborted) {
        throw error
      }
    } finally {
      this.connection.untrack(sub)
      this.connection.unsubscribeSafely(sub)
    }
  }

  private async runCommandResponder<TName extends CapsuleCommandName>(
    sub: Subscription,
    name: TName,
    handler: CapsuleCommandHandler<TName>,
    options: CapsuleCommandHandlerOptions,
  ): Promise<void> {
    const shutdownSignal = this.connection.signal
    try {
      for await (const msg of sub) {
        if (shutdownSignal.aborted) {
          break
        }
        if (!msg.reply) {
          continue
        }
        const envelope = await this.processCommandMessage(msg, name, handler, options)
        this.respondJson(msg, envelope)
      }
    } catch (error: unknown) {
      if (!shutdownSignal.aborted) {
        console.error(`${this.loggerPrefix} Command responder loop terminated for '${name}'.`, error)
      }
    } finally {
      this.connection.untrack(sub)
      this.connection.unsubscribeSafely(sub)
    }
  }

  private async processCommandMessage<TName extends CapsuleCommandName>(
    msg: Msg,
    name: TName,
    handler: CapsuleCommandHandler<TName>,
    options: CapsuleCommandHandlerOptions,
  ): Promise<CapsuleRpcEnvelope> {
    const parsedSubject = parseCapsuleSubject(msg.subject)
    if (!parsedSubject || parsedSubject.kind !== CapsuleSubjectKind.COMMAND || parsedSubject.operation !== name) {
      return this.failureEnvelope(CapsuleChannelErrorCode.BAD_REQUEST, `Malformed capsule command subject for '${name}'.`, {
        subject: msg.subject,
      })
    }
    const definition = getCapsuleCommandDefinition(name)
    const decoded = decodeMessageJson(msg, {
      context: `capsule command '${name}' request`,
      emptyFallback: {},
    })
    if (!decoded.ok) {
      return this.failureEnvelope(CapsuleChannelErrorCode.BAD_REQUEST, `Malformed JSON payload for capsule command '${name}'.`, {
        parseError: this.transportErrorDetails(decoded.error),
      })
    }
    const parsedInput = this.safeParseCommandInput(definition, decoded.data)
    if (!parsedInput.ok) {
      return this.failureEnvelope(CapsuleChannelErrorCode.BAD_REQUEST, `Invalid payload for capsule command '${name}'.`, parsedInput.details)
    }
    const expectedTarget = this.safeResolveDefinitionTarget(definition, parsedInput.data)
    if (!expectedTarget.ok) {
      return this.failureEnvelope(
        CapsuleChannelErrorCode.BAD_REQUEST,
        `Failed to resolve capsule command target for '${name}'.`,
        expectedTarget.details,
      )
    }
    if (!isTargetEqual(parsedSubject.target, expectedTarget.data)) {
      return this.failureEnvelope(CapsuleChannelErrorCode.FORBIDDEN, `Capsule command '${name}' target does not match payload target.`, {
        subjectTarget: parsedSubject.target,
        expectedTarget: expectedTarget.data,
      })
    }
    try {
      const result = await handler(parsedInput.data, {
        target: expectedTarget.data,
        name,
      })
      const parsedOutput = this.safeParseCommandOutput(definition, result)
      if (!parsedOutput.ok) {
        console.error(`${this.loggerPrefix} Output validation failed for capsule command '${name}'.`, parsedOutput.details)
        return this.failureEnvelope(CapsuleChannelErrorCode.INTERNAL_ERROR, `Invalid output for capsule command '${name}'.`)
      }
      return createCapsuleRpcSuccessEnvelope(parsedOutput.data)
    } catch (error: unknown) {
      return this.mapCommandError(error, options)
    }
  }

  private mapCommandError(error: unknown, options: CapsuleCommandHandlerOptions): CapsuleRpcFailureEnvelope {
    try {
      const failure = options.mapError ? options.mapError(error) : toCapsuleCommandFailure(error, 'Internal capsule command handler error.')
      return createCapsuleRpcFailureEnvelope(failure)
    } catch (mapperError: unknown) {
      return this.failureEnvelope(CapsuleChannelErrorCode.INTERNAL_ERROR, 'Capsule command error mapper failed.', {
        originalError: detailsFromUnknown(error),
        mapperError: detailsFromUnknown(mapperError),
      })
    }
  }

  private decodeEventMessage(msg: Msg): CapsuleEventEnvelope | null {
    const parsedSubject = parseCapsuleSubject(msg.subject)
    if (!parsedSubject || parsedSubject.kind !== CapsuleSubjectKind.EVENT) {
      console.warn(`${this.loggerPrefix} Dropping event with malformed capsule subject '${msg.subject}'.`)
      return null
    }
    const definition = getCapsuleEventDefinition(parsedSubject.operation)
    if (!definition) {
      console.warn(`${this.loggerPrefix} Dropping event with unknown capsule event name '${parsedSubject.operation}'.`)
      return null
    }
    const decoded = decodeMessageJson(msg, {
      context: `capsule event '${definition.name}'`,
      emptyFallback: {},
    })
    if (!decoded.ok) {
      console.warn(`${this.loggerPrefix} Dropping capsule event '${definition.name}' with malformed JSON payload.`, {
        parseError: this.transportErrorDetails(decoded.error),
      })
      return null
    }
    const parsedEvent = CapsuleEventSchema.safeParse(decoded.data)
    if (!parsedEvent.success) {
      console.warn(`${this.loggerPrefix} Dropping malformed capsule event '${definition.name}'.`, validationDetails(parsedEvent.error))
      return null
    }
    if (parsedEvent.data.type !== definition.name) {
      console.warn(`${this.loggerPrefix} Dropping capsule event whose payload type does not match subject operation.`, {
        payloadType: parsedEvent.data.type,
        subjectOperation: definition.name,
      })
      return null
    }
    const expectedTarget = this.safeResolveDefinitionTarget(definition, parsedEvent.data)
    if (!expectedTarget.ok) {
      console.warn(`${this.loggerPrefix} Dropping capsule event '${definition.name}' because target resolution failed.`, expectedTarget.details)
      return null
    }
    if (!isTargetEqual(parsedSubject.target, expectedTarget.data)) {
      console.warn(`${this.loggerPrefix} Dropping capsule event '${definition.name}' whose subject target does not match payload target.`, {
        subjectTarget: parsedSubject.target,
        expectedTarget: expectedTarget.data,
      })
      return null
    }
    return {
      target: expectedTarget.data,
      event: parsedEvent.data,
    }
  }

  private safeResolveDefinitionTarget(definition: CapsuleTargetedDefinition, payload: unknown): ParseResult<Target> {
    let rawTarget: Target
    try {
      rawTarget = definition.target.resolve(payload)
    } catch (error: unknown) {
      return {
        ok: false,
        details: {
          target: {
            message: `Failed to resolve target for capsule operation '${definition.name}'.`,
            error: detailsFromUnknown(error),
          },
        },
      }
    }
    const parsedTarget = TargetSchema.safeParse(rawTarget)
    if (!parsedTarget.success) {
      return {
        ok: false,
        details: validationDetails(parsedTarget.error),
      }
    }
    if (parsedTarget.data.type !== definition.target.type) {
      return {
        ok: false,
        details: {
          target: {
            expectedType: definition.target.type,
            actualType: parsedTarget.data.type,
            value: parsedTarget.data,
          },
        },
      }
    }
    return {
      ok: true,
      data: parsedTarget.data,
    }
  }

  private safeParseCommandInput<TName extends CapsuleCommandName>(
    definition: CapsuleCommandDefinitionFor<TName>,
    value: unknown,
  ): ParseResult<CapsuleCommandParsedInput<TName>> {
    const parsed = definition.inputSchema.safeParse(value)
    if (!parsed.success) {
      return {
        ok: false,
        details: validationDetails(parsed.error),
      }
    }
    return {
      ok: true,
      data: parsed.data as unknown as CapsuleCommandParsedInput<TName>,
    }
  }

  private safeParseCommandOutput<TName extends CapsuleCommandName>(
    definition: CapsuleCommandDefinitionFor<TName>,
    value: unknown,
  ): ParseResult<CapsuleCommandOutput<TName>> {
    const parsed = definition.outputSchema.safeParse(value)
    if (!parsed.success) {
      return {
        ok: false,
        details: validationDetails(parsed.error),
      }
    }
    return {
      ok: true,
      data: parsed.data as unknown as CapsuleCommandOutput<TName>,
    }
  }

  private safeParseEventInput<TName extends CapsuleEventName>(
    definition: CapsuleEventDefinitionFor<TName>,
    value: unknown,
  ): ParseResult<CapsuleEventOutput<TName>> {
    const parsed = definition.schema.safeParse(value)
    if (!parsed.success) {
      return {
        ok: false,
        details: validationDetails(parsed.error),
      }
    }

    return {
      ok: true,
      data: parsed.data as unknown as CapsuleEventOutput<TName>,
    }
  }

  private safeParseRpcEnvelope(value: unknown): ParseResult<CapsuleRpcEnvelope> {
    const parsed = CapsuleRpcEnvelopeSchema.safeParse(value)
    if (!parsed.success) {
      return {
        ok: false,
        details: validationDetails(parsed.error),
      }
    }
    return {
      ok: true,
      data: parsed.data,
    }
  }

  private failureEnvelope(code: CapsuleChannelErrorCode, message: string, details?: unknown): CapsuleRpcFailureEnvelope {
    return createCapsuleRpcFailureEnvelope(details === undefined ? { code, message } : { code, message, details })
  }

  private respondJson(msg: Msg, payload: unknown): void {
    try {
      respondNatsJson(msg, payload, {
        context: `capsule RPC response on subject '${msg.subject}'`,
        fallbackPayload: this.failureEnvelope(CapsuleChannelErrorCode.INTERNAL_ERROR, 'Capsule command returned a non-serializable response.'),
      })
    } catch (error: unknown) {
      console.error(`${this.loggerPrefix} Failed to serialize/send capsule RPC response on subject '${msg.subject}'.`, error)
    }
  }

  private toCapsuleCommandTransportError(commandName: string, error: unknown): CapsuleChannelError {
    if (!isNatsTransportError(error)) {
      return new CapsuleChannelError(`Failed to send capsule command '${commandName}'.`, {
        code: CapsuleChannelErrorCode.TRANSPORT_ERROR,
        details: detailsFromUnknown(error),
      })
    }
    const details = this.transportErrorDetails(error)
    if (error.code === NatsTransportErrorCode.TIMEOUT) {
      return new CapsuleChannelError(`Capsule command '${commandName}' timed out.`, {
        code: CapsuleChannelErrorCode.TIMEOUT,
        details,
      })
    }
    if (error.code === NatsTransportErrorCode.SERIALIZATION_ERROR) {
      return new CapsuleChannelError(`Failed to serialize capsule command '${commandName}' request.`, {
        code: CapsuleChannelErrorCode.BAD_REQUEST,
        details,
      })
    }
    if (error.code === NatsTransportErrorCode.PARSE_ERROR) {
      return new CapsuleChannelError(`Failed to parse capsule command '${commandName}' response JSON.`, {
        code: CapsuleChannelErrorCode.INTERNAL_ERROR,
        details,
      })
    }
    if (error.code === NatsTransportErrorCode.NOT_STARTED) {
      return new CapsuleChannelError(error.message, {
        code: CapsuleChannelErrorCode.TRANSPORT_ERROR,
        details,
      })
    }
    return new CapsuleChannelError(`Failed to send capsule command '${commandName}'.`, {
      code: CapsuleChannelErrorCode.TRANSPORT_ERROR,
      details,
    })
  }

  private toCapsulePublishTransportError(eventName: string, error: unknown): CapsuleChannelError {
    if (!isNatsTransportError(error)) {
      return new CapsuleChannelError(`Failed to publish capsule event '${eventName}'.`, {
        code: CapsuleChannelErrorCode.TRANSPORT_ERROR,
        details: detailsFromUnknown(error),
      })
    }
    const details = this.transportErrorDetails(error)
    if (error.code === NatsTransportErrorCode.SERIALIZATION_ERROR) {
      return new CapsuleChannelError(`Failed to serialize capsule event '${eventName}'.`, {
        code: CapsuleChannelErrorCode.BAD_REQUEST,
        details,
      })
    }
    if (error.code === NatsTransportErrorCode.NOT_STARTED) {
      return new CapsuleChannelError(error.message, {
        code: CapsuleChannelErrorCode.TRANSPORT_ERROR,
        details,
      })
    }
    return new CapsuleChannelError(`Failed to publish capsule event '${eventName}'.`, {
      code: CapsuleChannelErrorCode.TRANSPORT_ERROR,
      details,
    })
  }

  private transportErrorDetails(error: NatsTransportError): Record<string, unknown> | undefined {
    if (error.details !== undefined) {
      return (
        detailsFromUnknown(error.details) ?? {
          name: error.name,
          message: error.message,
          code: error.code,
        }
      )
    }
    return {
      name: error.name,
      message: error.message,
      code: error.code,
    }
  }
}
