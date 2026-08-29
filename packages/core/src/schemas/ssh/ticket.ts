import { z } from 'zod'
import { SshCanonicalPublicKeySchema, SshTimestampSchema } from './key'

const OPAQUE_TICKET_PATTERN = /^[A-Za-z0-9_-]{43,128}$/
const TICKET_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/

/**
 * Short-lived opaque bearer ticket returned only after signed gateway
 * authentication succeeds.
 *
 * The plaintext value must never be persisted or logged. Host persistence
 * stores only `SshTicketHash`.
 */
export const SshOpaqueTicketSchema = z.string().regex(OPAQUE_TICKET_PATTERN, {
  message: 'SSH tickets must use bounded unpadded base64url encoding.',
})

export const SshTicketHashSchema = z.string().regex(TICKET_HASH_PATTERN, {
  message: "SSH ticket hashes must use the format 'sha256:<64 lowercase hex characters>'.",
})

export const SshTicketStatus = {
  ISSUED: 'issued',
  REDEEMED: 'redeemed',
  REVOKED: 'revoked',
} as const

export type SshTicketStatus = (typeof SshTicketStatus)[keyof typeof SshTicketStatus]

export const SshTicketStatusValues = [
  SshTicketStatus.ISSUED,
  SshTicketStatus.REDEEMED,
  SshTicketStatus.REVOKED,
] as const

export const SshTicketStatusSchema = z.enum(SshTicketStatusValues)

/**
 * Gateway eligibility request derived from the actually offered key.
 *
 * No branch, capsule, grant, destination, username, or authorization decision
 * is accepted from the SSH client.
 */
export const SshGatewayKeyEligibilityInputSchema = z
  .object({
    key: SshCanonicalPublicKeySchema,
  })
  .strict()

/**
 * An unsigned SSH public-key probe may receive only this eligibility result.
 *
 * Eligibility does not authenticate the connection and does not issue a ticket.
 */
export const SshGatewayKeyEligibilityOutputSchema = z
  .object({
    eligible: z.boolean(),
  })
  .strict()

/**
 * Ticket issuance input used only after `@qiln/ssh` verifies the signed
 * user-authentication request for the exact offered key.
 */
export const SshTicketIssueInputSchema = z
  .object({
    key: SshCanonicalPublicKeySchema,
  })
  .strict()

export const SshTicketIssueOutputSchema = z
  .object({
    ticket: SshOpaqueTicketSchema,
    expiresAt: SshTimestampSchema,
  })
  .strict()

export const SshTicketRedemptionInputSchema = z
  .object({
    ticket: SshOpaqueTicketSchema,
    key: SshCanonicalPublicKeySchema,
    gatewayInstanceId: z.string().trim().min(1).max(128),
  })
  .strict()

/**
 * Server-side durable ticket projection.
 *
 * This shape contains only a cryptographic ticket hash and binding identities.
 * The raw opaque ticket is intentionally absent.
 */
export const SshTicketRecordSchema = z
  .object({
    id: z.uuid(),
    ticketHash: SshTicketHashSchema,
    publicKeyId: z.uuid(),
    grantId: z.uuid(),
    userId: z.uuid(),
    capsuleId: z.uuid(),
    branchId: z.uuid(),
    status: SshTicketStatusSchema,
    expiresAt: SshTimestampSchema,
    issuedAt: SshTimestampSchema,
    redeemedAt: SshTimestampSchema.nullable(),
    revokedAt: SshTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((ticket, context) => {
    if (ticket.status === SshTicketStatus.ISSUED) {
      if (ticket.redeemedAt !== null || ticket.revokedAt !== null) {
        context.addIssue({
          code: 'custom',
          message: 'An issued SSH ticket cannot have redemption or revocation timestamps.',
        })
      }
      return
    }
    if (ticket.status === SshTicketStatus.REDEEMED && ticket.redeemedAt === null) {
      context.addIssue({
        code: 'custom',
        path: ['redeemedAt'],
        message: 'A redeemed SSH ticket requires a redemption timestamp.',
      })
    }
    if (ticket.status === SshTicketStatus.REVOKED && ticket.revokedAt === null) {
      context.addIssue({
        code: 'custom',
        path: ['revokedAt'],
        message: 'A revoked SSH ticket requires a revocation timestamp.',
      })
    }
  })

export type SshOpaqueTicket = z.infer<typeof SshOpaqueTicketSchema>
export type SshTicketHash = z.infer<typeof SshTicketHashSchema>
export type SshGatewayKeyEligibilityInput = z.infer<typeof SshGatewayKeyEligibilityInputSchema>
export type SshGatewayKeyEligibilityOutput = z.infer<typeof SshGatewayKeyEligibilityOutputSchema>
export type SshTicketIssueInput = z.infer<typeof SshTicketIssueInputSchema>
export type SshTicketIssueOutput = z.infer<typeof SshTicketIssueOutputSchema>
export type SshTicketRedemptionInput = z.infer<typeof SshTicketRedemptionInputSchema>
export type SshTicketRecord = z.infer<typeof SshTicketRecordSchema>
