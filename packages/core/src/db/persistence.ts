import type { CapsuleTables } from './capsule/schema'

/**
 * Host-composed persistence dependency supplied to package modules.
 *
 * The host owns the final Drizzle database and physical table composition.
 * Package repositories must use the injected table handles rather than
 * constructing parallel handles for the same physical tables.
 *
 * The database remains generic because the host relation schema also contains
 * host-owned tables and relations that Core cannot define.
 */
export interface CapsulePersistence<TDatabase, TTables extends CapsuleTables = CapsuleTables> {
  readonly db: TDatabase
  readonly tables: TTables
}
