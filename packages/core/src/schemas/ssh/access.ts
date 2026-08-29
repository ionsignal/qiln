import { z } from 'zod'
import { CapsuleBranchNameSchema } from '../capsule/branch'
import { SshTimestampSchema } from './key'

export const SshBranchAccessState = {
  BLOCKED: 'blocked',
  ENABLED: 'enabled',
} as const

export type SshBranchAccessState = (typeof SshBranchAccessState)[keyof typeof SshBranchAccessState]

export const SshBranchAccessStateValues = [SshBranchAccessState.BLOCKED, SshBranchAccessState.ENABLED] as const
export const SshBranchAccessStateSchema = z.enum(SshBranchAccessStateValues)

/**
 * Durable reasons for blocking editable-branch SSH access.
 *
 * These values describe access-fence policy rather than provider runtime
 * failure details.
 */
export const SshBranchAccessBlockReason = {
  BRANCH_CREATED: 'branch_created',
  BRANCH_FORKED: 'branch_forked',
  BRANCH_STOP: 'branch_stop',
  SNAPSHOT_CAPTURE: 'snapshot_capture',
  CAPSULE_ARCHIVE: 'capsule_archive',
  CAPSULE_DESTROY: 'capsule_destroy',
  ADMIN_REVOKED: 'admin_revoked',
  POLICY_FAILURE: 'policy_failure',
} as const

export type SshBranchAccessBlockReason = (typeof SshBranchAccessBlockReason)[keyof typeof SshBranchAccessBlockReason]

export const SshBranchAccessBlockReasonValues = [
  SshBranchAccessBlockReason.BRANCH_CREATED,
  SshBranchAccessBlockReason.BRANCH_FORKED,
  SshBranchAccessBlockReason.BRANCH_STOP,
  SshBranchAccessBlockReason.SNAPSHOT_CAPTURE,
  SshBranchAccessBlockReason.CAPSULE_ARCHIVE,
  SshBranchAccessBlockReason.CAPSULE_DESTROY,
  SshBranchAccessBlockReason.ADMIN_REVOKED,
  SshBranchAccessBlockReason.POLICY_FAILURE,
] as const

export const SshBranchAccessBlockReasonSchema = z.enum(SshBranchAccessBlockReasonValues)

export const SshBranchAccessInitializationReasonSchema = z.enum([
  SshBranchAccessBlockReason.BRANCH_CREATED,
  SshBranchAccessBlockReason.BRANCH_FORKED,
])

export const SshBranchAccessRevocationReasonSchema = z.enum([
  SshBranchAccessBlockReason.BRANCH_STOP,
  SshBranchAccessBlockReason.SNAPSHOT_CAPTURE,
])

export const SshCapsuleAccessRevocationReasonSchema = z.enum([
  SshBranchAccessBlockReason.CAPSULE_ARCHIVE,
  SshBranchAccessBlockReason.CAPSULE_DESTROY,
])

/**
 * Client-safe state of the Host-owned per-branch SSH access fence.
 *
 * The branch relation remains authoritative for capsule and owner identity.
 * Capsule and branch names are included only as read projections.
 */
export const SshBranchAccessSummarySchema = z
  .object({
    branchId: z.uuid(),
    capsuleId: z.uuid(),
    branchName: CapsuleBranchNameSchema,
    state: SshBranchAccessStateSchema,
    blockReason: SshBranchAccessBlockReasonSchema.nullable(),
    enabledAt: SshTimestampSchema.nullable(),
    blockedAt: SshTimestampSchema.nullable(),
    createdAt: SshTimestampSchema,
    updatedAt: SshTimestampSchema,
  })
  .strict()
  .superRefine((access, context) => {
    if (access.state === SshBranchAccessState.ENABLED) {
      if (access.blockReason !== null) {
        context.addIssue({
          code: 'custom',
          path: ['blockReason'],
          message: 'An enabled branch SSH access fence cannot retain a block reason.',
        })
      }
      if (access.enabledAt === null) {
        context.addIssue({
          code: 'custom',
          path: ['enabledAt'],
          message: 'An enabled branch SSH access fence requires an enablement timestamp.',
        })
      }
      return
    }
    if (access.blockReason === null) {
      context.addIssue({
        code: 'custom',
        path: ['blockReason'],
        message: 'A blocked branch SSH access fence requires a block reason.',
      })
    }
    if (access.blockedAt === null) {
      context.addIssue({
        code: 'custom',
        path: ['blockedAt'],
        message: 'A blocked branch SSH access fence requires a block timestamp.',
      })
    }
  })

export type SshBranchAccessInitializationReason = z.infer<typeof SshBranchAccessInitializationReasonSchema>
export type SshBranchAccessRevocationReason = z.infer<typeof SshBranchAccessRevocationReasonSchema>
export type SshCapsuleAccessRevocationReason = z.infer<typeof SshCapsuleAccessRevocationReasonSchema>
export type SshBranchAccessSummary = z.infer<typeof SshBranchAccessSummarySchema>
