import { CapsuleLifecycleStateSchema, type CapsuleLifecycleState, type CapsuleLifecycleStatusValue } from '@qiln/core/server'
import { toNullableIsoTimestamp } from './timestamps'

export interface CapsuleLifecycleStateSource {
  capsuleId: string
  lifecycleStatus: CapsuleLifecycleStatusValue
  archivedAt: Date | null
  destroyedAt: Date | null
}

/**
 * Maps committed capsule persistence fields into the client-safe lifecycle
 * contract.
 *
 * Callers remain responsible for selecting state returned by a committed
 * transaction or authoritative read. This helper performs timestamp conversion
 * and schema validation only; it contains no lifecycle transition policy.
 */
export function toCapsuleLifecycleState(source: CapsuleLifecycleStateSource): CapsuleLifecycleState {
  const timestampContext = {
    entity: 'capsule',
    entityId: source.capsuleId,
  }
  return CapsuleLifecycleStateSchema.parse({
    capsuleId: source.capsuleId,
    lifecycleStatus: source.lifecycleStatus,
    archivedAt: toNullableIsoTimestamp(source.archivedAt, 'archivedAt', timestampContext),
    destroyedAt: toNullableIsoTimestamp(source.destroyedAt, 'destroyedAt', timestampContext),
  })
}
