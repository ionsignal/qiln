import {
  SshBranchAccessEnableInputSchema,
  SshBranchAccessInitializeInputSchema,
  SshBranchAccessMutationOutputSchema,
  SshBranchAccessRevokeInputSchema,
  SshCapsuleAccessRevokeInputSchema,
  SshCapsuleAccessRevocationOutputSchema,
} from '../../../schemas/ssh'
import { TargetOwnerSchema, TargetType } from '../targets'
import { defineCapsuleCommand } from './definitions'
import type { input, output } from 'zod'
import type { CapsuleCommandDefinition } from './definitions'

const SSH_ACCESS_CONTROL_TIMEOUT_MS = 60_000

/**
 * Private Worker-to-Host SSH access-control commands.
 *
 * The Host is authoritative for key registration, grants, access fences,
 * tickets, and relays. Worker callers supply only owner-targeted capsule and
 * branch identities plus the lifecycle reason represented by the command.
 *
 * Host handlers must independently prove branch ownership, capsule lineage,
 * access-fence state, lifecycle eligibility, and relay closure.
 */
export const CapsuleSshAccessCommandName = {
  BRANCH_ACCESS_INITIALIZE: 'capsule.ssh.access.initialize',
  BRANCH_ACCESS_ENABLE: 'capsule.ssh.access.enable',
  BRANCH_ACCESS_REVOKE: 'capsule.ssh.access.revokeBranch',
  CAPSULE_ACCESS_REVOKE: 'capsule.ssh.access.revokeCapsule',
} as const

export type CapsuleSshAccessCommandName = (typeof CapsuleSshAccessCommandName)[keyof typeof CapsuleSshAccessCommandName]

export const CapsuleSshAccessCommandNameValues = [
  CapsuleSshAccessCommandName.BRANCH_ACCESS_INITIALIZE,
  CapsuleSshAccessCommandName.BRANCH_ACCESS_ENABLE,
  CapsuleSshAccessCommandName.BRANCH_ACCESS_REVOKE,
  CapsuleSshAccessCommandName.CAPSULE_ACCESS_REVOKE,
] as const

export const CapsuleSshBranchAccessInitializeInputSchema = SshBranchAccessInitializeInputSchema.extend({
  target: TargetOwnerSchema,
}).strict()

export const CapsuleSshBranchAccessEnableInputSchema = SshBranchAccessEnableInputSchema.extend({
  target: TargetOwnerSchema,
}).strict()

export const CapsuleSshBranchAccessRevokeInputSchema = SshBranchAccessRevokeInputSchema.extend({
  target: TargetOwnerSchema,
}).strict()

export const CapsuleSshCapsuleAccessRevokeInputSchema = SshCapsuleAccessRevokeInputSchema.extend({
  target: TargetOwnerSchema,
}).strict()

export const CapsuleSshBranchAccessMutationOutputSchema = SshBranchAccessMutationOutputSchema
export const CapsuleSshCapsuleAccessRevocationOutputSchema = SshCapsuleAccessRevocationOutputSchema

export type CapsuleSshBranchAccessInitializeInput = input<typeof CapsuleSshBranchAccessInitializeInputSchema>
export type CapsuleSshBranchAccessInitialize = output<typeof CapsuleSshBranchAccessInitializeInputSchema>
export type CapsuleSshBranchAccessInitializeOutput = output<typeof CapsuleSshBranchAccessMutationOutputSchema>

export type CapsuleSshBranchAccessEnableInput = input<typeof CapsuleSshBranchAccessEnableInputSchema>
export type CapsuleSshBranchAccessEnable = output<typeof CapsuleSshBranchAccessEnableInputSchema>
export type CapsuleSshBranchAccessEnableOutput = output<typeof CapsuleSshBranchAccessMutationOutputSchema>

export type CapsuleSshBranchAccessRevokeInput = input<typeof CapsuleSshBranchAccessRevokeInputSchema>
export type CapsuleSshBranchAccessRevoke = output<typeof CapsuleSshBranchAccessRevokeInputSchema>
export type CapsuleSshBranchAccessRevokeOutput = output<typeof CapsuleSshBranchAccessMutationOutputSchema>

export type CapsuleSshCapsuleAccessRevokeInput = input<typeof CapsuleSshCapsuleAccessRevokeInputSchema>
export type CapsuleSshCapsuleAccessRevoke = output<typeof CapsuleSshCapsuleAccessRevokeInputSchema>
export type CapsuleSshCapsuleAccessRevokeOutput = output<typeof CapsuleSshCapsuleAccessRevocationOutputSchema>

export const CapsuleSshAccessCommandDefinitions = {
  [CapsuleSshAccessCommandName.BRANCH_ACCESS_INITIALIZE]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleSshAccessCommandName.BRANCH_ACCESS_INITIALIZE,
    inputSchema: CapsuleSshBranchAccessInitializeInputSchema,
    outputSchema: CapsuleSshBranchAccessMutationOutputSchema,
    timeoutMs: SSH_ACCESS_CONTROL_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleSshBranchAccessInitialize) {
        return payload.target
      },
    },
  }),
  [CapsuleSshAccessCommandName.BRANCH_ACCESS_ENABLE]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleSshAccessCommandName.BRANCH_ACCESS_ENABLE,
    inputSchema: CapsuleSshBranchAccessEnableInputSchema,
    outputSchema: CapsuleSshBranchAccessMutationOutputSchema,
    timeoutMs: SSH_ACCESS_CONTROL_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleSshBranchAccessEnable) {
        return payload.target
      },
    },
  }),
  [CapsuleSshAccessCommandName.BRANCH_ACCESS_REVOKE]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleSshAccessCommandName.BRANCH_ACCESS_REVOKE,
    inputSchema: CapsuleSshBranchAccessRevokeInputSchema,
    outputSchema: CapsuleSshBranchAccessMutationOutputSchema,
    timeoutMs: SSH_ACCESS_CONTROL_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleSshBranchAccessRevoke) {
        return payload.target
      },
    },
  }),
  [CapsuleSshAccessCommandName.CAPSULE_ACCESS_REVOKE]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleSshAccessCommandName.CAPSULE_ACCESS_REVOKE,
    inputSchema: CapsuleSshCapsuleAccessRevokeInputSchema,
    outputSchema: CapsuleSshCapsuleAccessRevocationOutputSchema,
    timeoutMs: SSH_ACCESS_CONTROL_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleSshCapsuleAccessRevoke) {
        return payload.target
      },
    },
  }),
} as const satisfies Record<CapsuleSshAccessCommandName, CapsuleCommandDefinition>
