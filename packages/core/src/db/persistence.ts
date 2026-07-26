import type { CapsuleTables } from './capsule/schema'

/**
 * Minimum composed table collection required by Qiln package persistence.
 *
 * Additional package-owned tables, including route aliases and revisions, may
 * extend this collection without weakening the capsule table requirements.
 */
export type QilnTables = CapsuleTables

/**
 * Host-composed persistence dependency supplied to package modules.
 *
 * The host owns the final Drizzle database and physical table composition.
 * Package repositories must use the injected table handles rather than
 * constructing parallel handles for the same physical tables.
 *
 * The database remains generic because the host's relation schema also contains
 * host-owned tables and relations that Core cannot define.
 */
export interface QilnPersistence<TDatabase, TTables extends QilnTables = QilnTables> {
  readonly db: TDatabase
  readonly tables: TTables
}
