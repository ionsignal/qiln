import { CapsuleActorReferenceSchema, CapsuleActorType } from '@qiln/core/server'
import type { EngineContext } from '../types'
import type { CapsuleMutationIdentity } from '../services/capsule/operations'

type AuthenticatedEngineUser = NonNullable<EngineContext['user']>

/**
 * Derives trusted capsule operation authority from the authenticated server
 * context.
 *
 * Browser input never supplies owner or actor attribution. The current
 * authentication model supports human users only, so ownership and actor
 * identity use the same authenticated user ID. A future agent-authentication
 * boundary may return an agent actor while preserving the authorized capsule
 * owner separately.
 */
export function createUserMutationIdentity(user: AuthenticatedEngineUser): CapsuleMutationIdentity {
  const actor = CapsuleActorReferenceSchema.parse({
    type: CapsuleActorType.USER,
    id: user.id,
  })
  return {
    ownerId: user.id,
    actor,
  }
}
