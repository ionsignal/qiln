import { mergeRelationFragments } from '../relations'
import { defineRelations as defineBaseRelations, type Helpers as BaseRelationHelpers } from './base/relations'
import { defineRelations as defineRoutingRelations, type Helpers as RoutingRelationHelpers } from './routing/relations'

export type CapsuleRelationHelpers = BaseRelationHelpers & RoutingRelationHelpers

/**
 * Defines the complete relation fragment owned by the capsule domain.
 *
 * The internal base and routing fragments remain independently maintainable,
 * while hosts install one capsule relation boundary. Duplicate relation names
 * fail during this composition step.
 */
export function defineCapsuleRelations(helpers: CapsuleRelationHelpers) {
  return mergeRelationFragments(defineBaseRelations(helpers), defineRoutingRelations(helpers))
}
