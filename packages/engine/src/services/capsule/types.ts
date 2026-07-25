import type { CapsuleActorReference } from '@qiln/core/server'

/**
 * Trusted mutation authority derived from authenticated Engine context.
 *
 * Capsule ownership and operation authorship are intentionally modeled
 * separately. A human currently owns and authors operations with the same user
 * ID, while a future agent boundary may authorize an agent actor to mutate a
 * human-owned capsule without conflating those identities.
 *
 * Browser input must never construct this value.
 */
export interface CapsuleMutationIdentity {
  readonly ownerId: string
  readonly actor: CapsuleActorReference
}
