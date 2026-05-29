import postgres from 'postgres'
import { relations } from '@server/db/schema'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

/**
 * Database Type
 */
export type Database = PostgresJsDatabase<typeof relations>

/**
 * Factory function to create the Postgres Data Layer.
 */
export function createDataLayer(connectionString: string) {
  if (!connectionString) {
    throw new Error('[Fatal] Database connection string is missing.')
  }
  const queryClient = postgres(connectionString, {
    max: 20,
    transform: { undefined: null },
  })
  const db = drizzle({
    client: queryClient,
    relations,
    logger: process.env.NODE_ENV === 'development',
  })
  const close = async () => {
    await queryClient.end()
  }
  return {
    db,
    close,
  }
}
