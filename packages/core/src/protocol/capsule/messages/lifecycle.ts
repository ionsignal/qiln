import { z } from 'zod'
import { TargetOwnerSchema, TargetType } from '../targets'
import { defineCapsuleEvent } from './definitions'
import { CapsuleLifecycleStateSchema } from '../../../schemas/capsule/lifecycle'
import type { CapsuleEventDefinition } from './definitions'

/**
 * Lifecycle events publish committed capsule aggregate state changes.
 *
 * Commands that request archive, unarchive, destroy, and create operations live
 * in `operations.ts` and `create.ts`, respectively.
 */
export const CapsuleLifecycleEventName = {
  LIFECYCLE_CHANGED: 'capsule.lifecycle.changed',
} as const

export type CapsuleLifecycleEventName = (typeof CapsuleLifecycleEventName)[keyof typeof CapsuleLifecycleEventName]

export const CapsuleLifecycleEventNameValues = [CapsuleLifecycleEventName.LIFECYCLE_CHANGED] as const

export const CapsuleLifecycleChangedEventSchema = z
  .object({
    type: z.literal(CapsuleLifecycleEventName.LIFECYCLE_CHANGED),
    target: TargetOwnerSchema,
    ...CapsuleLifecycleStateSchema.shape,
  })
  .strict()

export type CapsuleLifecycleChangedEvent = z.infer<typeof CapsuleLifecycleChangedEventSchema>

export const CapsuleLifecycleEventSchemas = [CapsuleLifecycleChangedEventSchema] as const

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
