import { z } from 'zod'
import {
  CapsuleBlueprintDigestSchema,
  CapsuleLifecycleIdempotencyKeySchema,
  CapsuleLifecycleOperationReceiptSchema,
  CapsuleLifecycleOperationType,
  DEFAULT_CAPSULE_BLUEPRINT_NAME,
} from '../../../schemas'
import { TargetOwnerSchema, TargetType } from '../targets'
import { CapsuleBranchNameSchema, CapsuleBranchStatusSchema } from './branch'
import { defineCapsuleCommand } from './definitions'
import type { input, output } from 'zod'
import type { CapsuleCommandDefinition } from './definitions'

const CAPSULE_BOOTSTRAP_CREATE_TIMEOUT_MS = 180_000

/**
 * Bootstrap commands initialize a new capsule aggregate and its root editable branch.
 * They are intentionally separate from future snapshot-based forks.
 */
export const CapsuleBootstrapCommandName = {
  BOOTSTRAP_CREATE: 'capsule.bootstrap.create',
} as const

export type CapsuleBootstrapCommandName = (typeof CapsuleBootstrapCommandName)[keyof typeof CapsuleBootstrapCommandName]
export const CapsuleBootstrapCommandNameValues = [CapsuleBootstrapCommandName.BOOTSTRAP_CREATE] as const

/**
 * Creates a capsule aggregate and provisions its root branch from a aller-reviewed blueprint digest. Bootstrap
 * remains internal protocol terminology. User-facing surfaces should describe this as creating a capsule.
 */
export const CapsuleBootstrapCreateInputSchema = z
  .object({
    target: TargetOwnerSchema,
    bootstrapBranchName: CapsuleBranchNameSchema,
    idempotencyKey: CapsuleLifecycleIdempotencyKeySchema,
    blueprintName: z.string().trim().min(1, 'Capsule blueprint name cannot be empty.').default(DEFAULT_CAPSULE_BLUEPRINT_NAME),
    blueprintDigest: CapsuleBlueprintDigestSchema,
    cpu: z.string().trim().min(1, 'CPU limit cannot be empty.').default('4'),
    memory: z.string().trim().min(1, 'Memory limit cannot be empty.').default('4GB'),
  })
  .strict()

export const CapsuleBootstrapCreateOutputSchema = CapsuleLifecycleOperationReceiptSchema.extend({
  capsuleId: z.uuid(),
  operationType: z.literal(CapsuleLifecycleOperationType.BOOTSTRAP),
  bootstrapBranchName: CapsuleBranchNameSchema,
  branchStatus: CapsuleBranchStatusSchema,
}).strict()

export type CapsuleBootstrapCreateInput = input<typeof CapsuleBootstrapCreateInputSchema>
export type CapsuleBootstrapCreate = output<typeof CapsuleBootstrapCreateInputSchema>
export type CapsuleBootstrapCreateOutput = output<typeof CapsuleBootstrapCreateOutputSchema>

export const CapsuleBootstrapCommandDefinitions = {
  [CapsuleBootstrapCommandName.BOOTSTRAP_CREATE]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleBootstrapCommandName.BOOTSTRAP_CREATE,
    inputSchema: CapsuleBootstrapCreateInputSchema,
    outputSchema: CapsuleBootstrapCreateOutputSchema,
    timeoutMs: CAPSULE_BOOTSTRAP_CREATE_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleBootstrapCreate) {
        return payload.target
      },
    },
  }),
} as const satisfies Record<CapsuleBootstrapCommandName, CapsuleCommandDefinition>
