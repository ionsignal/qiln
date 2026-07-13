import { z } from 'zod'

/**
 * Durable lifecycle state for the capsule aggregate.
 *
 * Archive is deliberately not represented here. An archived capsule remains
 * active and carries an `archivedAt` timestamp that can later be cleared by an
 * explicit unarchive operation.
 */
export const CapsuleLifecycleStatus = {
  PROVISIONING: 'provisioning',
  ACTIVE: 'active',
  DESTROYING: 'destroying',
  DESTROYED: 'destroyed',
  CREATION_FAILED: 'creation_failed',
  CLEANUP_REQUIRED: 'cleanup_required',
} as const

export type CapsuleLifecycleStatusValue = (typeof CapsuleLifecycleStatus)[keyof typeof CapsuleLifecycleStatus]

export const CapsuleLifecycleStatusValues = [
  CapsuleLifecycleStatus.PROVISIONING,
  CapsuleLifecycleStatus.ACTIVE,
  CapsuleLifecycleStatus.DESTROYING,
  CapsuleLifecycleStatus.DESTROYED,
  CapsuleLifecycleStatus.CREATION_FAILED,
  CapsuleLifecycleStatus.CLEANUP_REQUIRED,
] as const

export const CapsuleLifecycleStatusSchema = z.enum(CapsuleLifecycleStatusValues)

export const CapsuleLifecycleTimestampSchema = z.string().datetime({
  offset: true,
})

/**
 * Client-safe capsule lifecycle state.
 *
 * Provider resources and branch runtime details remain outside this aggregate
 * summary so logical archive state cannot be confused with Incus state.
 */
export const CapsuleLifecycleStateSchema = z
  .object({
    capsuleId: z.uuid(),
    lifecycleStatus: CapsuleLifecycleStatusSchema,
    archivedAt: CapsuleLifecycleTimestampSchema.nullable(),
    destroyedAt: CapsuleLifecycleTimestampSchema.nullable(),
  })
  .strict()

export type CapsuleLifecycleState = z.infer<typeof CapsuleLifecycleStateSchema>
