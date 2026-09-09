import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { users } from '../app/db/users'
import { capsuleTables } from '../app/db/capsule'
import { sshTables } from '../app/db/ssh'
import type { SshPersistence } from '@qiln/ssh/server'

/**
 * SSH uses explicit typed selections rather than Web's relational query graph.
 * Query logging stays disabled because SQL parameters can contain key material
 * and ticket hashes.
 */
export function createDatabase(connectionString: string) {
  if (!connectionString) {
    throw new Error('SSH database connection string is missing.')
  }
  const client = postgres(connectionString, {
    max: 20,
    transform: { undefined: null },
  })
  const db = drizzle({
    client,
    logger: false,
  })
  const persistence = {
    db,
    tables: {
      users,
      capsules: capsuleTables.capsules,
      capsuleBranches: capsuleTables.capsuleBranches,
      ...sshTables,
    },
  } satisfies SshPersistence
  return {
    persistence,
    async close(): Promise<void> {
      await client.end({ timeout: 5 })
    },
  }
}
