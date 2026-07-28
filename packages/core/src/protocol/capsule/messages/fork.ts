import { z } from 'zod'
import { CapsuleActorReferenceSchema } from '../../../schemas/capsule/actor'
import { CapsuleBranchNameSchema } from '../../../schemas/capsule/branch'
import { CapsuleForkReceiptSchema, CapsuleOperationIdempotencyKeySchema } from '../../../schemas/capsule/operations'
import { TargetOwnerSchema, TargetType } from '../targets'
import { defineCapsuleCommand } from './definitions'
import type { input, output } from 'zod'
import type { CapsuleCommandDefinition } from './definitions'

const CAPSULE_FORK_ACCEPTANCE_TIMEOUT_MS = 15_000

/**
 * Creates an editable branch from one committed experimental snapshot.
 *
 * The command returns after durable acceptance. Exact provider cloning and
 * branch materialization continue under the Worker operation supervisor.
 *
 * Actor provenance must be derived by the authenticated command publisher.
 */
export const CapsuleForkCommandName = {
  CAPSULE_FORK: 'capsule.fork',
} as const

export type CapsuleForkCommandName = (typeof CapsuleForkCommandName)[keyof typeof CapsuleForkCommandName]

export const CapsuleForkCommandNameValues = [CapsuleForkCommandName.CAPSULE_FORK] as const

export const CapsuleForkInputSchema = z
  .object({
    target: TargetOwnerSchema,
    actor: CapsuleActorReferenceSchema,
    capsuleId: z.uuid(),
    sourceSnapshotId: z.uuid(),
    branchName: CapsuleBranchNameSchema,
    idempotencyKey: CapsuleOperationIdempotencyKeySchema,
    cpu: z.string().trim().min(1, 'CPU limit cannot be empty.').default('4'),
    memory: z.string().trim().min(1, 'Memory limit cannot be empty.').default('4GB'),
  })
  .strict()

export const CapsuleForkOutputSchema = CapsuleForkReceiptSchema

export type CapsuleForkInput = input<typeof CapsuleForkInputSchema>
export type CapsuleFork = output<typeof CapsuleForkInputSchema>
export type CapsuleForkOutput = output<typeof CapsuleForkOutputSchema>

export const CapsuleForkCommandDefinitions = {
  [CapsuleForkCommandName.CAPSULE_FORK]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleForkCommandName.CAPSULE_FORK,
    inputSchema: CapsuleForkInputSchema,
    outputSchema: CapsuleForkOutputSchema,
    timeoutMs: CAPSULE_FORK_ACCEPTANCE_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleFork) {
        return payload.target
      },
    },
  }),
} as const satisfies Record<CapsuleForkCommandName, CapsuleCommandDefinition>
