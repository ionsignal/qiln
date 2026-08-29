import { z } from 'zod'
import { SshTimestampSchema } from './key'

const GATEWAY_INSTANCE_ID_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._:-]{0,126}[a-zA-Z0-9])?$/
const RELAY_CLOSURE_REASON_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._:-]{0,126}[a-zA-Z0-9])?$/

export const SshGatewayInstanceIdSchema = z.string().min(1).max(128).regex(GATEWAY_INSTANCE_ID_PATTERN, {
  message: 'SSH gateway instance IDs contain unsupported characters.',
})

export const SshRelayStatus = {
  OPENING: 'opening',
  ACTIVE: 'active',
  CLOSING: 'closing',
  CLOSED: 'closed',
} as const

export type SshRelayStatus = (typeof SshRelayStatus)[keyof typeof SshRelayStatus]

export const SshRelayStatusValues = [
  SshRelayStatus.OPENING,
  SshRelayStatus.ACTIVE,
  SshRelayStatus.CLOSING,
  SshRelayStatus.CLOSED,
] as const

export const SshRelayStatusSchema = z.enum(SshRelayStatusValues)

export const SshRelayClosureReasonSchema = z.string().min(1).max(128).regex(RELAY_CLOSURE_REASON_PATTERN, {
  message: 'SSH relay closure reasons contain unsupported characters.',
})

/**
 * Exact Host-authorized private SSH destination.
 *
 * The gateway must never accept this shape from an SSH client. It is returned
 * only by Host policy after ticket redemption or relay activation checks.
 */
export const SshBranchDestinationSchema = z
  .object({
    host: z.union([z.ipv4(), z.ipv6()]),
    port: z.literal(22),
  })
  .strict()

export const SshRelayOpeningSchema = z
  .object({
    relayId: z.uuid(),
    destination: SshBranchDestinationSchema,
    openedAt: SshTimestampSchema,
  })
  .strict()

export const SshRelayActivationInputSchema = z
  .object({
    relayId: z.uuid(),
    gatewayInstanceId: SshGatewayInstanceIdSchema,
  })
  .strict()

/**
 * Host activation output after access state is rechecked.
 *
 * The gateway must dial this returned destination only after this activation
 * succeeds.
 */
export const SshRelayActivationOutputSchema = z
  .object({
    relayId: z.uuid(),
    destination: SshBranchDestinationSchema,
    activatedAt: SshTimestampSchema,
  })
  .strict()

export const SshRelayCloseInputSchema = z
  .object({
    relayId: z.uuid(),
    gatewayInstanceId: SshGatewayInstanceIdSchema,
    reason: SshRelayClosureReasonSchema,
  })
  .strict()

export const SshRelayCloseOutputSchema = z
  .object({
    relayId: z.uuid(),
    closedAt: SshTimestampSchema,
  })
  .strict()

/**
 * Durable relay audit and revocation-coordination record.
 *
 * Runtime destinations are deliberately absent. Relay rows are not destination
 * authority and cannot be used to reconnect a relay.
 */
export const SshRelayRecordSchema = z
  .object({
    id: z.uuid(),
    ticketId: z.uuid(),
    publicKeyId: z.uuid(),
    userId: z.uuid(),
    capsuleId: z.uuid(),
    branchId: z.uuid(),
    gatewayInstanceId: SshGatewayInstanceIdSchema,
    status: SshRelayStatusSchema,
    openedAt: SshTimestampSchema,
    activatedAt: SshTimestampSchema.nullable(),
    closingAt: SshTimestampSchema.nullable(),
    closedAt: SshTimestampSchema.nullable(),
    closureReason: SshRelayClosureReasonSchema.nullable(),
  })
  .strict()
  .superRefine((relay, context) => {
    if (relay.status === SshRelayStatus.OPENING) {
      if (relay.activatedAt !== null || relay.closingAt !== null || relay.closedAt !== null) {
        context.addIssue({
          code: 'custom',
          message: 'An opening SSH relay cannot contain active or closing timestamps.',
        })
      }
      return
    }
    if (relay.status === SshRelayStatus.ACTIVE && relay.activatedAt === null) {
      context.addIssue({
        code: 'custom',
        path: ['activatedAt'],
        message: 'An active SSH relay requires an activation timestamp.',
      })
    }
    if (relay.status === SshRelayStatus.CLOSING && relay.closingAt === null) {
      context.addIssue({
        code: 'custom',
        path: ['closingAt'],
        message: 'A closing SSH relay requires a closing timestamp.',
      })
    }
    if (relay.status === SshRelayStatus.CLOSED && relay.closedAt === null) {
      context.addIssue({
        code: 'custom',
        path: ['closedAt'],
        message: 'A closed SSH relay requires a closure timestamp.',
      })
    }
    if (
      (relay.status === SshRelayStatus.CLOSING || relay.status === SshRelayStatus.CLOSED) &&
      relay.closureReason === null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['closureReason'],
        message: 'A closing or closed SSH relay requires a closure reason.',
      })
    }
  })

export type SshGatewayInstanceId = z.infer<typeof SshGatewayInstanceIdSchema>
export type SshRelayClosureReason = z.infer<typeof SshRelayClosureReasonSchema>
export type SshBranchDestination = z.infer<typeof SshBranchDestinationSchema>
export type SshRelayOpening = z.infer<typeof SshRelayOpeningSchema>
export type SshRelayActivationInput = z.infer<typeof SshRelayActivationInputSchema>
export type SshRelayActivationOutput = z.infer<typeof SshRelayActivationOutputSchema>
export type SshRelayCloseInput = z.infer<typeof SshRelayCloseInputSchema>
export type SshRelayCloseOutput = z.infer<typeof SshRelayCloseOutputSchema>
export type SshRelayRecord = z.infer<typeof SshRelayRecordSchema>
