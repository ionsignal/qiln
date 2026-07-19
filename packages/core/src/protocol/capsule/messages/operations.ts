import { z } from 'zod'
import {
  CapsuleActorReferenceSchema,
  CapsuleArchiveReceiptSchema,
  CapsuleDestroyReceiptSchema,
  CapsuleOperationIdempotencyKeySchema,
  CapsuleOperationStatusSchema,
  CapsuleOperationTypeSchema,
  CapsuleUnarchiveReceiptSchema,
} from '../../../schemas'
import { TargetOwnerSchema, TargetType } from '../targets'
import { defineCapsuleCommand, defineCapsuleEvent } from './definitions'
import type { input, output } from 'zod'
import type { CapsuleCommandDefinition, CapsuleEventDefinition } from './definitions'

const CAPSULE_OPERATION_ACCEPTANCE_TIMEOUT_MS = 15_000

export const CapsuleOperationCommandName = {
  CAPSULE_ARCHIVE: 'capsule.archive',
  CAPSULE_UNARCHIVE: 'capsule.unarchive',
  CAPSULE_DESTROY: 'capsule.destroy',
} as const

export type CapsuleOperationCommandName = (typeof CapsuleOperationCommandName)[keyof typeof CapsuleOperationCommandName]

export const CapsuleOperationCommandNameValues = [
  CapsuleOperationCommandName.CAPSULE_ARCHIVE,
  CapsuleOperationCommandName.CAPSULE_UNARCHIVE,
  CapsuleOperationCommandName.CAPSULE_DESTROY,
] as const

export const CapsuleOperationEventName = {
  OPERATION_CHANGED: 'capsule.operation.changed',
} as const

export type CapsuleOperationEventName = (typeof CapsuleOperationEventName)[keyof typeof CapsuleOperationEventName]

export const CapsuleOperationEventNameValues = [CapsuleOperationEventName.OPERATION_CHANGED] as const

/**
 * Common owner-targeted mutation identity.
 *
 * The actor is the authenticated principal that authored the operation. It is
 * supplied by a trusted server-side publisher rather than by browser input.
 */
const CapsuleOperationCommandInputSchema = z
  .object({
    target: TargetOwnerSchema,
    actor: CapsuleActorReferenceSchema,
    capsuleId: z.uuid(),
    idempotencyKey: CapsuleOperationIdempotencyKeySchema,
  })
  .strict()

export const CapsuleArchiveOperationInputSchema = CapsuleOperationCommandInputSchema
export const CapsuleUnarchiveOperationInputSchema = CapsuleOperationCommandInputSchema
export const CapsuleDestroyOperationInputSchema = CapsuleOperationCommandInputSchema

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

/**
 * Best-effort owner-targeted invalidation event.
 *
 * Clients must refetch durable operation and capsule reads after receiving this
 * event or reconnecting. It is not a replayable source of truth.
 */
export const CapsuleOperationChangedEventSchema = z
  .object({
    type: z.literal(CapsuleOperationEventName.OPERATION_CHANGED),
    target: TargetOwnerSchema,
    operationId: z.uuid(),
    operationType: CapsuleOperationTypeSchema,
    operationStatus: CapsuleOperationStatusSchema,
    capsuleId: z.uuid(),
    branchId: z.uuid().nullable(),
  })
  .strict()

export type CapsuleOperationChangedEvent = z.infer<typeof CapsuleOperationChangedEventSchema>

export const CapsuleOperationEventSchemas = [CapsuleOperationChangedEventSchema] as const

export const CapsuleOperationCommandDefinitions = {
  [CapsuleOperationCommandName.CAPSULE_ARCHIVE]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleOperationCommandName.CAPSULE_ARCHIVE,
    inputSchema: CapsuleArchiveOperationInputSchema,
    outputSchema: CapsuleArchiveOperationOutputSchema,
    timeoutMs: CAPSULE_OPERATION_ACCEPTANCE_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleArchiveOperation) {
        return payload.target
      },
    },
  }),
  [CapsuleOperationCommandName.CAPSULE_UNARCHIVE]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleOperationCommandName.CAPSULE_UNARCHIVE,
    inputSchema: CapsuleUnarchiveOperationInputSchema,
    outputSchema: CapsuleUnarchiveOperationOutputSchema,
    timeoutMs: CAPSULE_OPERATION_ACCEPTANCE_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleUnarchiveOperation) {
        return payload.target
      },
    },
  }),
  [CapsuleOperationCommandName.CAPSULE_DESTROY]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleOperationCommandName.CAPSULE_DESTROY,
    inputSchema: CapsuleDestroyOperationInputSchema,
    outputSchema: CapsuleDestroyOperationOutputSchema,
    timeoutMs: CAPSULE_OPERATION_ACCEPTANCE_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleDestroyOperation) {
        return payload.target
      },
    },
  }),
} as const satisfies Record<CapsuleOperationCommandName, CapsuleCommandDefinition>

export const CapsuleOperationEventDefinitions = {
  [CapsuleOperationEventName.OPERATION_CHANGED]: defineCapsuleEvent({
    kind: 'capsule.event',
    name: CapsuleOperationEventName.OPERATION_CHANGED,
    schema: CapsuleOperationChangedEventSchema,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleOperationChangedEvent) {
        return payload.target
      },
    },
  }),
} as const satisfies Record<CapsuleOperationEventName, CapsuleEventDefinition>
