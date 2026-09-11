import postgres from 'postgres'
import { capsuleTables } from '@/db/capsule'
import { relations } from '@server/db/relations'
import { QueryLogger } from '@server/db/log'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { CapsulePersistence } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

/**
 * Host database type containing host-owned and composed package relations.
 */
export type Database = PostgresJsDatabase<typeof relations>

/**
 * Package persistence dependency backed by the host's final composed schema.
 */
export type Persistence = CapsulePersistence<Database, typeof capsuleTables>

export interface DatabaseOptions {
  queries: boolean
}

/**
 * Creates the Web database connection and package persistence dependency.
 */
export function createDatabase(connectionString: string, options: DatabaseOptions) {
  if (!connectionString) {
    throw new Error('[Fatal] Database connection string is missing.')
  }
  const client = postgres(connectionString, {
    max: 20,
    transform: { undefined: null },
  })
  const db = drizzle({
    client,
    relations,
    logger: options.queries === true ? new QueryLogger() : false,
  })
  const persistence = {
    db,
    tables: capsuleTables,
  } satisfies Persistence
  const close = async () => {
    await client.end()
  }
  return {
    db,
    persistence,
    close,
  }
}
