import type { QilnPersistence, QilnTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

/**
 * Server-only persistence boundary supplied by the host application.
 *
 * The runtime object retains the host's exact composed database and table
 * handles. Engine services depend only on the capsule table contract they
 * require for authoritative reads.
 */
export type EnginePersistence = QilnPersistence<PostgresJsDatabase, QilnTables>
