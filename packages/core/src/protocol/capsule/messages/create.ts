import { z } from 'zod'
import {
  CapsuleBlueprintDigestSchema,
  CapsuleCreateReceiptSchema,
  CapsuleOperationIdempotencyKeySchema,
  DEFAULT_CAPSULE_BLUEPRINT_NAME,
} from '../../../schemas'
import { TargetOwnerSchema, TargetType } from '../targets'
import { defineCapsuleCommand } from './definitions'
import type { input, output } from 'zod'
import type { CapsuleCommandDefinition } from './definitions'

const CAPSULE_CREATE_ACCEPTANCE_TIMEOUT_MS = 15_000

/**
 * Creates a durable capsule aggregate and its root editable branch.
 *
 * The command returns only after durable operation acceptance. Provider
 * provisioning continues under the Worker operation supervisor.
 */
export const CapsuleCreateCommandName = {
  CAPSULE_CREATE: 'capsule.create',
} as const

export type CapsuleCreateCommandName = (typeof CapsuleCreateCommandName)[keyof typeof CapsuleCreateCommandName]

export const CapsuleCreateCommandNameValues = [CapsuleCreateCommandName.CAPSULE_CREATE] as const

export const CapsuleCreateInputSchema = z
  .object({
    target: TargetOwnerSchema,
    rootBranchName: z
      .string()
      .min(1)
      .max(50)
      .regex(
        /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,48}[a-zA-Z0-9])?$/,
        'Capsule branch name must be alphanumeric, can contain hyphens, but cannot start or end with a hyphen.',
      ),
    idempotencyKey: CapsuleOperationIdempotencyKeySchema,
    blueprintName: z.string().trim().min(1, 'Capsule blueprint name cannot be empty.').default(DEFAULT_CAPSULE_BLUEPRINT_NAME),
    blueprintDigest: CapsuleBlueprintDigestSchema,
    cpu: z.string().trim().min(1, 'CPU limit cannot be empty.').default('4'),
    memory: z.string().trim().min(1, 'Memory limit cannot be empty.').default('4GB'),
  })
  .strict()

export const CapsuleCreateOutputSchema = CapsuleCreateReceiptSchema

export type CapsuleCreateInput = input<typeof CapsuleCreateInputSchema>
export type CapsuleCreate = output<typeof CapsuleCreateInputSchema>
export type CapsuleCreateOutput = output<typeof CapsuleCreateOutputSchema>

export const CapsuleCreateCommandDefinitions = {
  [CapsuleCreateCommandName.CAPSULE_CREATE]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleCreateCommandName.CAPSULE_CREATE,
    inputSchema: CapsuleCreateInputSchema,
    outputSchema: CapsuleCreateOutputSchema,
    timeoutMs: CAPSULE_CREATE_ACCEPTANCE_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleCreate) {
        return payload.target
      },
    },
  }),
} as const satisfies Record<CapsuleCreateCommandName, CapsuleCommandDefinition>
