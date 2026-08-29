import { z } from 'zod'
import { CapsuleBranchNameSchema } from '../capsule/branch'
import {
  SshPublicKeyAlgorithmSchema,
  SshPublicKeyFingerprintSchema,
  SshPublicKeyLabelSchema,
  SshTimestampSchema,
} from './key'

const SSH_CONFIG_ALIAS_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,126}[a-zA-Z0-9])?$/

export const SshBranchGrantStatus = {
  ACTIVE: 'active',
  REVOKED: 'revoked',
} as const

export type SshBranchGrantStatus = (typeof SshBranchGrantStatus)[keyof typeof SshBranchGrantStatus]

export const SshBranchGrantStatusValues = [SshBranchGrantStatus.ACTIVE, SshBranchGrantStatus.REVOKED] as const
export const SshBranchGrantStatusSchema = z.enum(SshBranchGrantStatusValues)

/**
 * Client-safe admin and user projection of one SSH public-key binding.
 *
 * Owner and capsule identities are denormalized audit evidence in Host
 * persistence. Authorization must still prove current key, branch, capsule, and
 * access-fence relationships transactionally.
 */
export const SshBranchGrantSummarySchema = z
  .object({
    id: z.uuid(),
    publicKeyId: z.uuid(),
    keyOwnerUserId: z.uuid(),
    capsuleOwnerUserId: z.uuid(),
    capsuleId: z.uuid(),
    branchId: z.uuid(),
    branchName: CapsuleBranchNameSchema,
    boundByAdminUserId: z.uuid(),
    revokedByUserId: z.uuid().nullable(),
    keyAlgorithm: SshPublicKeyAlgorithmSchema,
    keyFingerprint: SshPublicKeyFingerprintSchema,
    keyLabel: SshPublicKeyLabelSchema.nullable(),
    status: SshBranchGrantStatusSchema,
    createdAt: SshTimestampSchema,
    revokedAt: SshTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((grant, context) => {
    if (grant.status === SshBranchGrantStatus.ACTIVE && grant.revokedAt !== null) {
      context.addIssue({
        code: 'custom',
        path: ['revokedAt'],
        message: 'An active SSH branch grant cannot have a revocation timestamp.',
      })
    }
    if (grant.status === SshBranchGrantStatus.REVOKED && grant.revokedAt === null) {
      context.addIssue({
        code: 'custom',
        path: ['revokedAt'],
        message: 'A revoked SSH branch grant requires a revocation timestamp.',
      })
    }
  })

export const SshBranchGrantBindInputSchema = z
  .object({
    publicKeyId: z.uuid(),
    branchId: z.uuid(),
  })
  .strict()

export const SshBranchGrantRevokeInputSchema = z
  .object({
    grantId: z.uuid(),
  })
  .strict()

export const SshOpenSshConfigInputSchema = z
  .object({
    publicKeyId: z.uuid(),
  })
  .strict()

export const SshConfigAliasSchema = z.string().min(1).max(128).regex(SSH_CONFIG_ALIAS_PATTERN, {
  message: 'Generated SSH config aliases contain unsupported characters.',
})

/**
 * Stock OpenSSH configuration generated for one active user key and grant.
 *
 * `config` contains no private key, ticket, destination IP, branch credential,
 * or callback credential.
 */
export const SshOpenSshConfigOutputSchema = z
  .object({
    gatewayHostAlias: SshConfigAliasSchema,
    branchHostAlias: SshConfigAliasSchema,
    branchName: CapsuleBranchNameSchema,
    config: z
      .string()
      .min(1)
      .max(16 * 1024),
  })
  .strict()

export type SshBranchGrantSummary = z.infer<typeof SshBranchGrantSummarySchema>
export type SshBranchGrantBindInput = z.infer<typeof SshBranchGrantBindInputSchema>
export type SshBranchGrantRevokeInput = z.infer<typeof SshBranchGrantRevokeInputSchema>
export type SshOpenSshConfigInput = z.infer<typeof SshOpenSshConfigInputSchema>
export type SshConfigAlias = z.infer<typeof SshConfigAliasSchema>
export type SshOpenSshConfigOutput = z.infer<typeof SshOpenSshConfigOutputSchema>
