import { z } from 'zod'

/**
 * Durable principal types that may author capsule operations.
 *
 * Owner identity and actor identity are intentionally distinct. The owner
 * controls the capsule aggregate, while the actor identifies the principal
 * that requested one durable mutation.
 */
export const CapsuleActorType = {
  USER: 'user',
  AGENT: 'agent',
} as const

export type CapsuleActorTypeValue = (typeof CapsuleActorType)[keyof typeof CapsuleActorType]
export const CapsuleActorTypeValues = [CapsuleActorType.USER, CapsuleActorType.AGENT] as const
export const CapsuleActorTypeSchema = z.enum(CapsuleActorTypeValues)

/**
 * Immutable actor provenance attached to a durable capsule operation.
 *
 * Actor IDs are polymorphic references and deliberately have no database
 * foreign key. Historical operation attribution must remain available after a
 * user or agent principal is retired.
 */
export const CapsuleActorReferenceSchema = z
  .object({
    type: CapsuleActorTypeSchema,
    id: z.uuid(),
  })
  .strict()

export type CapsuleActorReference = z.infer<typeof CapsuleActorReferenceSchema>
