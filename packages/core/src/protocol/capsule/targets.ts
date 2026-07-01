import { z } from 'zod'

const NATS_TOKEN_SEPARATOR = '.'
const NATS_WILDCARD_TOKEN = '*'
const NATS_DEEP_WILDCARD_TOKEN = '>'

export const SYSTEM_TARGET_ID = 'global'

export const TargetType = {
  OWNER: 'owner',
  CAPSULE: 'capsule',
  SYSTEM: 'system',
} as const

export type TargetTypeValue = (typeof TargetType)[keyof typeof TargetType]
export type TargetType = TargetTypeValue

export const TargetTypeValues = [TargetType.OWNER, TargetType.CAPSULE, TargetType.SYSTEM] as const
export const TargetTypeSchema = z.enum(TargetTypeValues)

export function isSubjectSafeTargetId(id: string): boolean {
  return (
    id.length > 0 &&
    id.trim() === id &&
    !id.includes(NATS_TOKEN_SEPARATOR) &&
    !id.includes(NATS_WILDCARD_TOKEN) &&
    !id.includes(NATS_DEEP_WILDCARD_TOKEN)
  )
}

export function assertSubjectSafeTargetId(id: string, context = 'capsule target id'): asserts id is string {
  if (!isSubjectSafeTargetId(id)) {
    throw new Error(`${context} must be a concrete NATS subject token: non-empty, trimmed, and without '.', '*', or '>'.`)
  }
}

const TargetUuidSchema = z.uuid().refine(isSubjectSafeTargetId, {
  message: "Capsule target UUIDs must be concrete NATS subject tokens and cannot contain '.', '*', or '>'.",
})

export const TargetOwnerSchema = z
  .object({
    type: z.literal(TargetType.OWNER),
    id: TargetUuidSchema,
  })
  .strict()

export const TargetCapsuleSchema = z
  .object({
    type: z.literal(TargetType.CAPSULE),
    id: TargetUuidSchema,
  })
  .strict()

export const TargetSystemSchema = z
  .object({
    type: z.literal(TargetType.SYSTEM),
    id: z.literal(SYSTEM_TARGET_ID).refine(isSubjectSafeTargetId, {
      message: "The system target id must be a concrete NATS subject token and cannot contain '.', '*', or '>'.",
    }),
  })
  .strict()

export const TargetSchema = z.discriminatedUnion('type', [TargetOwnerSchema, TargetCapsuleSchema, TargetSystemSchema])

export type TargetOwner = z.infer<typeof TargetOwnerSchema>
export type TargetCapsule = z.infer<typeof TargetCapsuleSchema>
export type SystemTarget = z.infer<typeof TargetSystemSchema>
export type Target = z.infer<typeof TargetSchema>

export function isTargetEqual(left: Target, right: Target): boolean {
  return left.type === right.type && left.id === right.id
}

export function assertTarget(value: unknown, context = 'capsule target'): asserts value is Target {
  const parsed = TargetSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`Invalid ${context}.`)
  }
  assertSubjectSafeTargetId(parsed.data.id, context)
}
