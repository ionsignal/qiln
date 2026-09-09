import { z } from 'zod'
import { CapsuleActorReferenceSchema } from '../../../../schemas/capsule/actor'
import {
  CapsuleArchiveReceiptSchema,
  CapsuleDestroyReceiptSchema,
  CapsuleOperationIdempotencyKeySchema,
  CapsuleUnarchiveReceiptSchema,
} from '../../../../schemas/capsule/operations'
import { TargetOwnerSchema, TargetType } from '../../targets'
import { defineCapsuleCommand } from '../../definitions'
import type { input, output } from 'zod'
import type { CapsuleCommandDefinition } from '../../definitions'

const CAPSULE_LIFECYCLE_ACCEPTANCE_TIMEOUT_MS = 15_000

export const CapsuleLifecycleCommandName = {
  CAPSULE_ARCHIVE: 'capsule.archive',
  CAPSULE_UNARCHIVE: 'capsule.unarchive',
  CAPSULE_DESTROY: 'capsule.destroy',
} as const

export type CapsuleLifecycleCommandName = (typeof CapsuleLifecycleCommandName)[keyof typeof CapsuleLifecycleCommandName]

export const CapsuleLifecycleCommandNameValues = [
  CapsuleLifecycleCommandName.CAPSULE_ARCHIVE,
  CapsuleLifecycleCommandName.CAPSULE_UNARCHIVE,
  CapsuleLifecycleCommandName.CAPSULE_DESTROY,
] as const

/**
 * Common owner-targeted lifecycle mutation identity.
 *
 * The actor is supplied by a trusted server-side publisher rather than browser
 * input.
 */
const CapsuleLifecycleCommandInputSchema = z
  .object({
    target: TargetOwnerSchema,
    actor: CapsuleActorReferenceSchema,
    capsuleId: z.uuid(),
    idempotencyKey: CapsuleOperationIdempotencyKeySchema,
  })
  .strict()

export const CapsuleArchiveOperationInputSchema = CapsuleLifecycleCommandInputSchema
export const CapsuleUnarchiveOperationInputSchema = CapsuleLifecycleCommandInputSchema
export const CapsuleDestroyOperationInputSchema = CapsuleLifecycleCommandInputSchema

export const CapsuleArchiveOperationOutputSchema = CapsuleArchiveReceiptSchema
export const CapsuleUnarchiveOperationOutputSchema = CapsuleUnarchiveReceiptSchema
export const CapsuleDestroyOperationOutputSchema = CapsuleDestroyReceiptSchema

export type CapsuleArchiveOperationInput = input<typeof CapsuleArchiveOperationInputSchema>
export type CapsuleArchiveOperation = output<typeof CapsuleArchiveOperationInputSchema>
export type CapsuleArchiveOperationOutput = output<typeof CapsuleArchiveOperationOutputSchema>

export type CapsuleUnarchiveOperationInput = input<typeof CapsuleUnarchiveOperationInputSchema>
export type CapsuleUnarchiveOperation = output<typeof CapsuleUnarchiveOperationInputSchema>
export type CapsuleUnarchiveOperationOutput = output<typeof CapsuleUnarchiveOperationOutputSchema>

export type CapsuleDestroyOperationInput = input<typeof CapsuleDestroyOperationInputSchema>
export type CapsuleDestroyOperation = output<typeof CapsuleDestroyOperationInputSchema>
export type CapsuleDestroyOperationOutput = output<typeof CapsuleDestroyOperationOutputSchema>

export const CapsuleLifecycleCommandDefinitions = {
  [CapsuleLifecycleCommandName.CAPSULE_ARCHIVE]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleLifecycleCommandName.CAPSULE_ARCHIVE,
    inputSchema: CapsuleArchiveOperationInputSchema,
    outputSchema: CapsuleArchiveOperationOutputSchema,
    timeoutMs: CAPSULE_LIFECYCLE_ACCEPTANCE_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleArchiveOperation) {
        return payload.target
      },
    },
  }),
  [CapsuleLifecycleCommandName.CAPSULE_UNARCHIVE]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleLifecycleCommandName.CAPSULE_UNARCHIVE,
    inputSchema: CapsuleUnarchiveOperationInputSchema,
    outputSchema: CapsuleUnarchiveOperationOutputSchema,
    timeoutMs: CAPSULE_LIFECYCLE_ACCEPTANCE_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleUnarchiveOperation) {
        return payload.target
      },
    },
  }),
  [CapsuleLifecycleCommandName.CAPSULE_DESTROY]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleLifecycleCommandName.CAPSULE_DESTROY,
    inputSchema: CapsuleDestroyOperationInputSchema,
    outputSchema: CapsuleDestroyOperationOutputSchema,
    timeoutMs: CAPSULE_LIFECYCLE_ACCEPTANCE_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleDestroyOperation) {
        return payload.target
      },
    },
  }),
} as const satisfies Record<CapsuleLifecycleCommandName, CapsuleCommandDefinition>
