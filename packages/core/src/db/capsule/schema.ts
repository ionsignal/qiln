import type { PgColumn } from 'drizzle-orm/pg-core'
import { createSchema as createBaseSchema } from './base/schema'
import { createSchema as createRoutingSchema } from './routing/schema'

/**
 * Creates the complete capsule-domain physical schema using one host-provided
 * user identity column.
 *
 * Routing consumes the exact capsule, operation, and snapshot handles created
 * by the base fragment. Package repositories must receive these same composed
 * handles through `CapsulePersistence`.
 */
export function createCapsuleSchema<TUserIdColumn extends PgColumn>(userIdColumn: TUserIdColumn) {
  const base = createBaseSchema(userIdColumn)
  const routing = createRoutingSchema(
    userIdColumn,
    base.capsules.id,
    base.capsuleOperations.id,
    base.capsuleSnapshots.id,
  )
  return {
    ...base,
    ...routing,
  }
}

export type CapsuleTables = ReturnType<typeof createCapsuleSchema>
