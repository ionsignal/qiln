import { z } from 'zod'

/**
 * Durable lifecycle state for the capsule aggregate.
 *
 * Archive remains reversible logical state represented by `archivedAt`.
 * `archiving` and `unarchiving` are durable mutation fences while accepted
 * capsule operations execute under the Worker control plane.
 */
export const CapsuleLifecycleStatus = {
  PROVISIONING: 'provisioning',
  ACTIVE: 'active',
  ARCHIVING: 'archiving',
  UNARCHIVING: 'unarchiving',
  DESTROYING: 'destroying',
  DESTROYED: 'destroyed',
  CREATION_FAILED: 'creation_failed',
  CLEANUP_REQUIRED: 'cleanup_required',
} as const

export type CapsuleLifecycleStatusValue = (typeof CapsuleLifecycleStatus)[keyof typeof CapsuleLifecycleStatus]

export const CapsuleLifecycleStatusValues = [
  CapsuleLifecycleStatus.PROVISIONING,
  CapsuleLifecycleStatus.ACTIVE,
  CapsuleLifecycleStatus.ARCHIVING,
  CapsuleLifecycleStatus.UNARCHIVING,
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
