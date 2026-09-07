import { z } from 'zod'
import { GlobalErrorCode } from '../../errors'
import { SshGatewayInstanceIdSchema } from './relay'

export const SSH_GATEWAY_DIAGNOSTIC_MARKER = 'session-callbacks-v1'

export const SshGatewayDiagnosticStageSchema = z.enum([
  'gateway',
  'connection',
  'authentication',
  'session',
  'request',
  'shell',
  'redemption',
  'registration',
  'activation',
  'dial',
  'pipe',
  'relay',
  'closure',
])

export const SshGatewayDiagnosticOutcomeSchema = z.enum([
  'started',
  'accepted',
  'rejected',
  'succeeded',
  'failed',
  'timed_out',
  'closed',
])

export const SshGatewayDiagnosticRequestSchema = z.enum([
  'pty',
  'env',
  'exec',
  'subsystem',
  'x11',
  'auth-agent',
  'signal',
  'window-change',
  'tcpip',
])

export const SshGatewayDiagnosticReasonSchema = z.enum([
  'shutdown',
  'connection_limit',
  'connection_closed',
  'not_authenticated',
  'missing_ticket',
  'missing_key',
  'session_already_accepted',
  'shell_already_accepted',
  'session_unavailable',
  'channel_unavailable',
  'unsupported_request',
  'relay_limit',
  'relay_tombstoned',
  'registry_capacity',
  'relay_closed_before_dial',
  'relay_closed_during_dial',
  'relay_closed_before_stream',
  'invalid_destination',
  'dial_timeout',
  'dial_closed',
  'authentication_timeout',
  'channel_timeout',
  'channel_error',
  'upstream_error',
  'host_revoked',
  'stream_closed',
  'setup_failed',
])

/**
 * Only explicitly approved error codes may leave the gateway error boundary.
 *
 * Database errors can contain SQL parameters and nested provider diagnostics,
 * so messages, stacks, and error objects are never diagnostic fields.
 */
export const SshGatewayDiagnosticCodeSchema = z.enum([
  GlobalErrorCode.BAD_REQUEST,
  GlobalErrorCode.UNAUTHORIZED,
  GlobalErrorCode.FORBIDDEN,
  GlobalErrorCode.NOT_FOUND,
  GlobalErrorCode.CONFLICT,
  GlobalErrorCode.INTERNAL_ERROR,
  GlobalErrorCode.TIMEOUT,
  '23502',
  '23503',
  '23505',
  '23514',
  '40001',
  '40P01',
  '42P01',
  '42703',
  '55P03',
  '57014',
  '08006',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EADDRINUSE',
  'EADDRNOTAVAIL',
  'EACCES',
])

export const SshGatewayDiagnosticErrorSchema = z
  .object({
    kind: z.enum(['type_error', 'validation_error', 'coded_error', 'unknown_error']),
    code: SshGatewayDiagnosticCodeSchema.optional(),
  })
  .strict()

/**
 * Server-only gateway diagnostics shared with the Host logging adapter.
 *
 * Connection and relay IDs provide correlation without exposing tickets, ticket
 * hashes, public-key material, request payloads, or branch destinations.
 */
export const SshGatewayDiagnosticSchema = z
  .object({
    gatewayInstanceId: SshGatewayInstanceIdSchema,
    connectionId: z.uuid().optional(),
    relayId: z.uuid().optional(),
    stage: SshGatewayDiagnosticStageSchema,
    outcome: SshGatewayDiagnosticOutcomeSchema,
    reason: SshGatewayDiagnosticReasonSchema.optional(),
    request: SshGatewayDiagnosticRequestSchema.optional(),
    replyRequested: z.boolean().optional(),
    error: SshGatewayDiagnosticErrorSchema.optional(),
    marker: z.literal(SSH_GATEWAY_DIAGNOSTIC_MARKER).optional(),
  })
  .strict()

export type SshGatewayDiagnosticStage = z.infer<typeof SshGatewayDiagnosticStageSchema>
export type SshGatewayDiagnosticRequest = z.infer<typeof SshGatewayDiagnosticRequestSchema>
export type SshGatewayDiagnosticReason = z.infer<typeof SshGatewayDiagnosticReasonSchema>
export type SshGatewayDiagnosticError = z.infer<typeof SshGatewayDiagnosticErrorSchema>
export type SshGatewayDiagnostic = z.infer<typeof SshGatewayDiagnosticSchema>
