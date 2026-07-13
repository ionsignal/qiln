import { z } from 'zod'
import {
  CapsuleLifecycleIdempotencyKeySchema,
  CapsuleLifecycleOperationType,
  CapsuleLifecycleReceiptSchema,
  CapsuleLifecycleStateSchema,
} from '../../../schemas'
import { TargetOwnerSchema, TargetType } from '../targets'
import { defineCapsuleCommand, defineCapsuleEvent } from './definitions'
import type { input, output } from 'zod'
import type { CapsuleCommandDefinition, CapsuleEventDefinition } from './definitions'

const CAPSULE_LOGICAL_LIFECYCLE_TIMEOUT_MS = 15_000
const CAPSULE_DESTROY_TIMEOUT_MS = 15 * 60_000

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

export const CapsuleLifecycleEventName = {
  LIFECYCLE_CHANGED: 'capsule.lifecycle.changed',
} as const

export type CapsuleLifecycleEventName = (typeof CapsuleLifecycleEventName)[keyof typeof CapsuleLifecycleEventName]
export const CapsuleLifecycleEventNameValues = [CapsuleLifecycleEventName.LIFECYCLE_CHANGED] as const

const CapsuleLifecycleCommandInputSchema = z
  .object({
    target: TargetOwnerSchema,
    capsuleId: z.uuid(),
    idempotencyKey: CapsuleLifecycleIdempotencyKeySchema,
  })
  .strict()

export const CapsuleArchiveInputSchema = CapsuleLifecycleCommandInputSchema
export const CapsuleUnarchiveInputSchema = CapsuleLifecycleCommandInputSchema
export const CapsuleDestroyInputSchema = CapsuleLifecycleCommandInputSchema

export const CapsuleArchiveOutputSchema = CapsuleLifecycleReceiptSchema.extend({
  operationType: z.literal(CapsuleLifecycleOperationType.ARCHIVE),
}).strict()

export const CapsuleUnarchiveOutputSchema = CapsuleLifecycleReceiptSchema.extend({
  operationType: z.literal(CapsuleLifecycleOperationType.UNARCHIVE),
}).strict()

export const CapsuleDestroyOutputSchema = CapsuleLifecycleReceiptSchema.extend({
  operationType: z.literal(CapsuleLifecycleOperationType.DESTROY),
}).strict()

export type CapsuleArchiveInput = input<typeof CapsuleArchiveInputSchema>
export type CapsuleArchive = output<typeof CapsuleArchiveInputSchema>
export type CapsuleArchiveOutput = output<typeof CapsuleArchiveOutputSchema>

export type CapsuleUnarchiveInput = input<typeof CapsuleUnarchiveInputSchema>
export type CapsuleUnarchive = output<typeof CapsuleUnarchiveInputSchema>
export type CapsuleUnarchiveOutput = output<typeof CapsuleUnarchiveOutputSchema>

export type CapsuleDestroyInput = input<typeof CapsuleDestroyInputSchema>
export type CapsuleDestroy = output<typeof CapsuleDestroyInputSchema>
export type CapsuleDestroyOutput = output<typeof CapsuleDestroyOutputSchema>

export const CapsuleLifecycleChangedEventSchema = z
  .object({
    type: z.literal(CapsuleLifecycleEventName.LIFECYCLE_CHANGED),
    target: TargetOwnerSchema,
    ...CapsuleLifecycleStateSchema.shape,
  })
  .strict()

export type CapsuleLifecycleChangedEvent = z.infer<typeof CapsuleLifecycleChangedEventSchema>
export const CapsuleLifecycleEventSchemas = [CapsuleLifecycleChangedEventSchema] as const

export const CapsuleLifecycleCommandDefinitions = {
  [CapsuleLifecycleCommandName.CAPSULE_ARCHIVE]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleLifecycleCommandName.CAPSULE_ARCHIVE,
    inputSchema: CapsuleArchiveInputSchema,
    outputSchema: CapsuleArchiveOutputSchema,
    timeoutMs: CAPSULE_LOGICAL_LIFECYCLE_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleArchive) {
        return payload.target
      },
    },
  }),
  [CapsuleLifecycleCommandName.CAPSULE_UNARCHIVE]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleLifecycleCommandName.CAPSULE_UNARCHIVE,
    inputSchema: CapsuleUnarchiveInputSchema,
    outputSchema: CapsuleUnarchiveOutputSchema,
    timeoutMs: CAPSULE_LOGICAL_LIFECYCLE_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleUnarchive) {
        return payload.target
      },
    },
  }),
  [CapsuleLifecycleCommandName.CAPSULE_DESTROY]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleLifecycleCommandName.CAPSULE_DESTROY,
    inputSchema: CapsuleDestroyInputSchema,
    outputSchema: CapsuleDestroyOutputSchema,
    timeoutMs: CAPSULE_DESTROY_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleDestroy) {
        return payload.target
      },
    },
  }),
} as const satisfies Record<CapsuleLifecycleCommandName, CapsuleCommandDefinition>

export const CapsuleLifecycleEventDefinitions = {
  [CapsuleLifecycleEventName.LIFECYCLE_CHANGED]: defineCapsuleEvent({
    kind: 'capsule.event',
    name: CapsuleLifecycleEventName.LIFECYCLE_CHANGED,
    schema: CapsuleLifecycleChangedEventSchema,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleLifecycleChangedEvent) {
        return payload.target
      },
    },
  }),
} as const satisfies Record<CapsuleLifecycleEventName, CapsuleEventDefinition>
