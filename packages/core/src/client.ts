export * from './errors'
export * from './schemas/client'
export * from './protocol/capsule/targets'
export * from './protocol/capsule/messages'

export { CapsuleChannelError, CapsuleChannelErrorCodeSchema } from './protocol/capsule/channel'

export type {
  CapsuleChannel,
  CapsuleChannelErrorOptions,
  CapsuleChannelErrorCode,
  CapsuleCommandContext,
  CapsuleCommandFailure,
  CapsuleCommandHandler,
  CapsuleCommandHandlerOptions,
  CapsuleCommandInput,
  CapsuleCommandOutput,
  CapsuleCommandParsedInput,
  CapsuleCommandRawOutput,
  CapsuleEventEnvelope,
  CapsuleEventFilter,
  CapsuleEventInput,
  CapsuleEventOutput,
} from './protocol/capsule/channel'
