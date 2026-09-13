import type { CapsuleActorReference } from '@qiln/core/server'

/**
 * Trusted mutation authority derived from authenticated Engine context.
 *
 * Capsule ownership and operation authorship are intentionally modeled
 * separately. A human currently owns and authors operations with the same user
 * ID, while a future agent boundary may authorize an agent actor to mutate a
 * human-owned capsule without conflating those identities.
 *
 * Administrator status is request-scoped authorization context derived by the
 * Host. It is not browser-controlled actor provenance and is not persisted on
 * capsule operations.
 *
 * Browser input must never construct this value.
 */
export interface CapsuleMutationIdentity {
  readonly ownerId: string
  readonly actor: CapsuleActorReference
  readonly isAdmin: boolean
}
