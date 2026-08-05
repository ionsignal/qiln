import { z } from 'zod'
import { CapsuleActorType } from '../capsule/actor'
import { CapsuleBranchNameSchema, CapsuleBranchStatusSchema } from '../capsule/branch'
import { CapsuleLifecycleStateSchema } from '../capsule/lifecycle'

export const AgentBranchSelectorSchema = z
  .object({
    branchId: z.uuid().optional(),
    branchName: CapsuleBranchNameSchema.optional(),
  })
  .strict()
  .superRefine((selector, context) => {
    if (selector.branchId !== undefined && selector.branchName !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Specify either branchId or branchName, not both.',
      })
    }
  })

/**
 * The external agent may supply only a branch selector. The host derives every
 * identity, capsule scope, and eligibility decision from its API credential.
 */
export const AgentGetContextInputSchema = AgentBranchSelectorSchema

export const AgentRequesterSchema = z
  .object({
    id: z.uuid(),
    username: z.string().min(1),
  })
  .strict()

export const AgentActorSchema = z
  .object({
    type: z.literal(CapsuleActorType.AGENT),
    id: z.uuid(),
  })
  .strict()

export const AgentBranchContextSchema = z
  .object({
    id: z.uuid(),
    name: CapsuleBranchNameSchema,
    isRootBranch: z.boolean(),
    status: CapsuleBranchStatusSchema,
  })
  .strict()

export const AgentDevelopmentIneligibilityReason = {
  CREDENTIAL_UNSCOPED: 'credential_unscoped',
  BRANCH_NOT_SELECTED: 'branch_not_selected',
  CAPSULE_NOT_ACTIVE: 'capsule_not_active',
  CAPSULE_ARCHIVED: 'capsule_archived',
  BRANCH_NOT_OFFLINE: 'branch_not_offline',
} as const

export type AgentDevelopmentIneligibilityReason =
  (typeof AgentDevelopmentIneligibilityReason)[keyof typeof AgentDevelopmentIneligibilityReason]

export const AgentDevelopmentIneligibilityReasonValues = [
  AgentDevelopmentIneligibilityReason.CREDENTIAL_UNSCOPED,
  AgentDevelopmentIneligibilityReason.BRANCH_NOT_SELECTED,
  AgentDevelopmentIneligibilityReason.CAPSULE_NOT_ACTIVE,
  AgentDevelopmentIneligibilityReason.CAPSULE_ARCHIVED,
  AgentDevelopmentIneligibilityReason.BRANCH_NOT_OFFLINE,
] as const

export const AgentDevelopmentIneligibilityReasonSchema = z.enum(AgentDevelopmentIneligibilityReasonValues)

export interface AgentDevelopmentEligibility {
  developmentEligible: boolean
  developmentIneligibilityReason: AgentDevelopmentIneligibilityReason | null
}

/**
 * Derives one canonical development decision from host-authoritative capsule
 * and branch state so clients never receive competing ineligibility reasons.
 */
export function getAgentDevelopmentEligibility(
  capsule: z.infer<typeof CapsuleLifecycleStateSchema> | null,
  branch: z.infer<typeof AgentBranchContextSchema> | null,
): AgentDevelopmentEligibility {
  if (capsule === null) {
    return {
      developmentEligible: false,
      developmentIneligibilityReason: AgentDevelopmentIneligibilityReason.CREDENTIAL_UNSCOPED,
    }
  }
  if (branch === null) {
    return {
      developmentEligible: false,
      developmentIneligibilityReason: AgentDevelopmentIneligibilityReason.BRANCH_NOT_SELECTED,
    }
  }
  if (capsule.lifecycleStatus !== 'active') {
    return {
      developmentEligible: false,
      developmentIneligibilityReason: AgentDevelopmentIneligibilityReason.CAPSULE_NOT_ACTIVE,
    }
  }
  if (capsule.archivedAt !== null) {
    return {
      developmentEligible: false,
      developmentIneligibilityReason: AgentDevelopmentIneligibilityReason.CAPSULE_ARCHIVED,
    }
  }
  if (branch.status !== 'offline') {
    return {
      developmentEligible: false,
      developmentIneligibilityReason: AgentDevelopmentIneligibilityReason.BRANCH_NOT_OFFLINE,
    }
  }
  return {
    developmentEligible: true,
    developmentIneligibilityReason: null,
  }
}

/**
 * Authoritative external-agent context returned by the host control plane.
 *
 * A selected branch is never authority by itself. The host proves that it
 * belongs to the API credential's capsule scope before returning it here.
 */
export const AgentGetContextOutputSchema = z
  .object({
    requester: AgentRequesterSchema,
    agent: AgentActorSchema,
    capsule: CapsuleLifecycleStateSchema.nullable(),
    branch: AgentBranchContextSchema.nullable(),
    developmentEligible: z.boolean(),
    developmentIneligibilityReason: AgentDevelopmentIneligibilityReasonSchema.nullable(),
  })
  .strict()
  .superRefine((value, issue) => {
    if (value.capsule === null && value.branch !== null) {
      issue.addIssue({
        code: 'custom',
        path: ['branch'],
        message: 'An unscoped agent credential cannot resolve a branch.',
      })
    }
    const expected = getAgentDevelopmentEligibility(value.capsule, value.branch)
    if (value.developmentEligible !== expected.developmentEligible) {
      issue.addIssue({
        code: 'custom',
        path: ['developmentEligible'],
        message: 'Development eligibility must match the authoritative capsule and branch state.',
      })
    }
    if (value.developmentIneligibilityReason !== expected.developmentIneligibilityReason) {
      issue.addIssue({
        code: 'custom',
        path: ['developmentIneligibilityReason'],
        message: 'Development ineligibility reason must match the authoritative capsule and branch state.',
      })
    }
  })

export type AgentBranchSelector = z.infer<typeof AgentBranchSelectorSchema>
export type AgentGetContextInput = z.input<typeof AgentGetContextInputSchema>
export type AgentGetContext = z.output<typeof AgentGetContextInputSchema>
export type AgentRequester = z.infer<typeof AgentRequesterSchema>
export type AgentActor = z.infer<typeof AgentActorSchema>
export type AgentBranchContext = z.infer<typeof AgentBranchContextSchema>
export type AgentGetContextOutput = z.infer<typeof AgentGetContextOutputSchema>
