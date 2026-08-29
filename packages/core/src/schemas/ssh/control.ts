import { z } from 'zod'
import {
  SshBranchAccessInitializationReasonSchema,
  SshBranchAccessRevocationReasonSchema,
  SshBranchAccessSummarySchema,
  SshCapsuleAccessRevocationReasonSchema,
} from './access'

export const SshBranchAccessInitializeInputSchema = z
  .object({
    capsuleId: z.uuid(),
    branchId: z.uuid(),
    reason: SshBranchAccessInitializationReasonSchema,
  })
  .strict()

export const SshBranchAccessEnableInputSchema = z
  .object({
    capsuleId: z.uuid(),
    branchId: z.uuid(),
  })
  .strict()

export const SshBranchAccessRevokeInputSchema = z
  .object({
    capsuleId: z.uuid(),
    branchId: z.uuid(),
    reason: SshBranchAccessRevocationReasonSchema,
  })
  .strict()

export const SshCapsuleAccessRevokeInputSchema = z
  .object({
    capsuleId: z.uuid(),
    reason: SshCapsuleAccessRevocationReasonSchema,
  })
  .strict()

/**
 * Committed Host revocation and relay-closure accounting.
 *
 * `relayClosureConfirmed: true` means every relay selected by the blocking
 * transaction has been closed in the local gateway registry and durably marked
 * closed. Worker lifecycle code must not proceed without this result.
 */
export const SshAccessRevocationReportSchema = z
  .object({
    revokedGrantCount: z.number().int().nonnegative(),
    revokedTicketCount: z.number().int().nonnegative(),
    closedRelayCount: z.number().int().nonnegative(),
    relayClosureConfirmed: z.literal(true),
  })
  .strict()

export const SshBranchAccessMutationOutputSchema = z
  .object({
    access: SshBranchAccessSummarySchema,
    changed: z.boolean(),
    revocation: SshAccessRevocationReportSchema.nullable(),
  })
  .strict()

export const SshCapsuleAccessRevocationOutputSchema = z
  .object({
    capsuleId: z.uuid(),
    branchAccess: z.array(SshBranchAccessSummarySchema),
    changed: z.boolean(),
    revocation: SshAccessRevocationReportSchema,
  })
  .strict()

export type SshBranchAccessInitializeInput = z.infer<typeof SshBranchAccessInitializeInputSchema>
export type SshBranchAccessEnableInput = z.infer<typeof SshBranchAccessEnableInputSchema>
export type SshBranchAccessRevokeInput = z.infer<typeof SshBranchAccessRevokeInputSchema>
export type SshCapsuleAccessRevokeInput = z.infer<typeof SshCapsuleAccessRevokeInputSchema>
export type SshAccessRevocationReport = z.infer<typeof SshAccessRevocationReportSchema>
export type SshBranchAccessMutationOutput = z.infer<typeof SshBranchAccessMutationOutputSchema>
export type SshCapsuleAccessRevocationOutput = z.infer<typeof SshCapsuleAccessRevocationOutputSchema>
