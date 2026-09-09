import { z } from 'zod'
import { CapsuleOperationStatusSchema, CapsuleOperationTypeSchema } from '../../../schemas/capsule/operations'
import { TargetOwnerSchema, TargetType } from '../targets'
import { defineCapsuleEvent } from '../definitions'
import type { CapsuleEventDefinition } from '../definitions'

/**
 * Generic durable-operation ledger invalidation.
 *
 * This event applies to every capsule operation type, including lifecycle,
 * branch, snapshot, route, create, and fork operations. Consumers must refetch
 * authoritative operation and domain state after receiving it.
 */
export const CapsuleOperationEventName = {
  OPERATION_CHANGED: 'capsule.operation.changed',
} as const

export type CapsuleOperationEventName = (typeof CapsuleOperationEventName)[keyof typeof CapsuleOperationEventName]

export const CapsuleOperationEventNameValues = [CapsuleOperationEventName.OPERATION_CHANGED] as const

export const CapsuleOperationChangedEventSchema = z
  .object({
    type: z.literal(CapsuleOperationEventName.OPERATION_CHANGED),
    target: TargetOwnerSchema,
    operationId: z.uuid(),
    operationType: CapsuleOperationTypeSchema,
    operationStatus: CapsuleOperationStatusSchema,
    capsuleId: z.uuid(),
  })
  .strict()

export type CapsuleOperationChangedEvent = z.infer<typeof CapsuleOperationChangedEventSchema>

export const CapsuleOperationEventSchemas = [CapsuleOperationChangedEventSchema] as const

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
