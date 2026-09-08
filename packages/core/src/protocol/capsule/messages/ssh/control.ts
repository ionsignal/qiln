import { z } from 'zod'
import {
  SshBranchGrantBindInputSchema,
  SshBranchGrantRevokeInputSchema,
  SshBranchGrantSummarySchema,
  SshOpenSshConfigInputSchema,
  SshOpenSshConfigOutputSchema,
  SshPublicKeyRegistrationInputSchema,
  SshPublicKeyRegistrationOutputSchema,
  SshPublicKeyRevokeInputSchema,
  SshPublicKeySummarySchema,
} from '../../../../schemas/ssh'
import { TargetOwnerSchema, TargetType } from '../../targets'
import { defineCapsuleCommand } from '../definitions'
import type { CapsuleCommandDefinition } from '../definitions'

const SSH_CONTROL_TIMEOUT_MS = 60_000

/**
 * Private Web-to-SSH management commands.
 *
 * Web derives target.id from the authenticated requester, never browser input.
 * For administrative commands this is the administrator, not the capsule owner.
 * SSH policy independently checks durable administrator state and resource
 * ownership.
 *
 * These commands retain the private NATS trust model. Payload validation does
 * not authenticate the publisher or replace future per-service permissions.
 */
export const CapsuleSshControlCommandName = {
  SSH_KEY_REGISTER: 'capsule.ssh.keys.register',
  SSH_KEYS_LIST: 'capsule.ssh.keys.list',
  SSH_KEY_REVOKE: 'capsule.ssh.keys.revoke',
  SSH_GRANT_BIND: 'capsule.ssh.grants.bind',
  SSH_GRANTS_LIST: 'capsule.ssh.grants.list',
  SSH_GRANT_REVOKE: 'capsule.ssh.grants.revoke',
  SSH_CONFIG: 'capsule.ssh.config',
} as const

export type CapsuleSshControlCommandName =
  (typeof CapsuleSshControlCommandName)[keyof typeof CapsuleSshControlCommandName]

export const CapsuleSshControlCommandNameValues = [
  CapsuleSshControlCommandName.SSH_KEY_REGISTER,
  CapsuleSshControlCommandName.SSH_KEYS_LIST,
  CapsuleSshControlCommandName.SSH_KEY_REVOKE,
  CapsuleSshControlCommandName.SSH_GRANT_BIND,
  CapsuleSshControlCommandName.SSH_GRANTS_LIST,
  CapsuleSshControlCommandName.SSH_GRANT_REVOKE,
  CapsuleSshControlCommandName.SSH_CONFIG,
] as const

const CapsuleSshControlInputSchema = z
  .object({
    target: TargetOwnerSchema,
  })
  .strict()

export const CapsuleSshKeyRegisterInputSchema = CapsuleSshControlInputSchema.extend(
  SshPublicKeyRegistrationInputSchema.shape,
).strict()
export const CapsuleSshKeyRegisterOutputSchema = SshPublicKeyRegistrationOutputSchema

export const CapsuleSshKeysListInputSchema = CapsuleSshControlInputSchema
export const CapsuleSshKeysListOutputSchema = z.array(SshPublicKeySummarySchema)

export const CapsuleSshKeyRevokeInputSchema = CapsuleSshControlInputSchema.extend(
  SshPublicKeyRevokeInputSchema.shape,
).strict()
export const CapsuleSshKeyRevokeOutputSchema = SshPublicKeySummarySchema

export const CapsuleSshGrantBindInputSchema = CapsuleSshControlInputSchema.extend(
  SshBranchGrantBindInputSchema.shape,
).strict()
export const CapsuleSshGrantBindOutputSchema = SshBranchGrantSummarySchema

export const CapsuleSshGrantsListInputSchema = CapsuleSshControlInputSchema
export const CapsuleSshGrantsListOutputSchema = z.array(SshBranchGrantSummarySchema)

export const CapsuleSshGrantRevokeInputSchema = CapsuleSshControlInputSchema.extend(
  SshBranchGrantRevokeInputSchema.shape,
).strict()
export const CapsuleSshGrantRevokeOutputSchema = SshBranchGrantSummarySchema

export const CapsuleSshConfigInputSchema = CapsuleSshControlInputSchema.extend(
  SshOpenSshConfigInputSchema.shape,
).strict()
export const CapsuleSshConfigOutputSchema = SshOpenSshConfigOutputSchema

export type CapsuleSshKeyRegisterInput = z.input<typeof CapsuleSshKeyRegisterInputSchema>
export type CapsuleSshKeyRegister = z.output<typeof CapsuleSshKeyRegisterInputSchema>
export type CapsuleSshKeyRegisterOutput = z.output<typeof CapsuleSshKeyRegisterOutputSchema>

export type CapsuleSshKeysListInput = z.input<typeof CapsuleSshKeysListInputSchema>
export type CapsuleSshKeysList = z.output<typeof CapsuleSshKeysListInputSchema>
export type CapsuleSshKeysListOutput = z.output<typeof CapsuleSshKeysListOutputSchema>

export type CapsuleSshKeyRevokeInput = z.input<typeof CapsuleSshKeyRevokeInputSchema>
export type CapsuleSshKeyRevoke = z.output<typeof CapsuleSshKeyRevokeInputSchema>
export type CapsuleSshKeyRevokeOutput = z.output<typeof CapsuleSshKeyRevokeOutputSchema>

export type CapsuleSshGrantBindInput = z.input<typeof CapsuleSshGrantBindInputSchema>
export type CapsuleSshGrantBind = z.output<typeof CapsuleSshGrantBindInputSchema>
export type CapsuleSshGrantBindOutput = z.output<typeof CapsuleSshGrantBindOutputSchema>

export type CapsuleSshGrantsListInput = z.input<typeof CapsuleSshGrantsListInputSchema>
export type CapsuleSshGrantsList = z.output<typeof CapsuleSshGrantsListInputSchema>
export type CapsuleSshGrantsListOutput = z.output<typeof CapsuleSshGrantsListOutputSchema>

export type CapsuleSshGrantRevokeInput = z.input<typeof CapsuleSshGrantRevokeInputSchema>
export type CapsuleSshGrantRevoke = z.output<typeof CapsuleSshGrantRevokeInputSchema>
export type CapsuleSshGrantRevokeOutput = z.output<typeof CapsuleSshGrantRevokeOutputSchema>

export type CapsuleSshConfigInput = z.input<typeof CapsuleSshConfigInputSchema>
export type CapsuleSshConfig = z.output<typeof CapsuleSshConfigInputSchema>
export type CapsuleSshConfigOutput = z.output<typeof CapsuleSshConfigOutputSchema>

export const CapsuleSshControlCommandDefinitions = {
  [CapsuleSshControlCommandName.SSH_KEY_REGISTER]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleSshControlCommandName.SSH_KEY_REGISTER,
    inputSchema: CapsuleSshKeyRegisterInputSchema,
    outputSchema: CapsuleSshKeyRegisterOutputSchema,
    timeoutMs: SSH_CONTROL_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleSshKeyRegister) {
        return payload.target
      },
    },
  }),
  [CapsuleSshControlCommandName.SSH_KEYS_LIST]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleSshControlCommandName.SSH_KEYS_LIST,
    inputSchema: CapsuleSshKeysListInputSchema,
    outputSchema: CapsuleSshKeysListOutputSchema,
    timeoutMs: SSH_CONTROL_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleSshKeysList) {
        return payload.target
      },
    },
  }),
  [CapsuleSshControlCommandName.SSH_KEY_REVOKE]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleSshControlCommandName.SSH_KEY_REVOKE,
    inputSchema: CapsuleSshKeyRevokeInputSchema,
    outputSchema: CapsuleSshKeyRevokeOutputSchema,
    timeoutMs: SSH_CONTROL_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleSshKeyRevoke) {
        return payload.target
      },
    },
  }),
  [CapsuleSshControlCommandName.SSH_GRANT_BIND]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleSshControlCommandName.SSH_GRANT_BIND,
    inputSchema: CapsuleSshGrantBindInputSchema,
    outputSchema: CapsuleSshGrantBindOutputSchema,
    timeoutMs: SSH_CONTROL_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleSshGrantBind) {
        return payload.target
      },
    },
  }),
  [CapsuleSshControlCommandName.SSH_GRANTS_LIST]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleSshControlCommandName.SSH_GRANTS_LIST,
    inputSchema: CapsuleSshGrantsListInputSchema,
    outputSchema: CapsuleSshGrantsListOutputSchema,
    timeoutMs: SSH_CONTROL_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleSshGrantsList) {
        return payload.target
      },
    },
  }),
  [CapsuleSshControlCommandName.SSH_GRANT_REVOKE]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleSshControlCommandName.SSH_GRANT_REVOKE,
    inputSchema: CapsuleSshGrantRevokeInputSchema,
    outputSchema: CapsuleSshGrantRevokeOutputSchema,
    timeoutMs: SSH_CONTROL_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleSshGrantRevoke) {
        return payload.target
      },
    },
  }),
  [CapsuleSshControlCommandName.SSH_CONFIG]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleSshControlCommandName.SSH_CONFIG,
    inputSchema: CapsuleSshConfigInputSchema,
    outputSchema: CapsuleSshConfigOutputSchema,
    timeoutMs: SSH_CONTROL_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleSshConfig) {
        return payload.target
      },
    },
  }),
} as const satisfies Record<CapsuleSshControlCommandName, CapsuleCommandDefinition>
