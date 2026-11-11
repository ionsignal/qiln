import postgres from 'postgres'
import { loadEnvironmentConfig } from '@server/env'

/**
 * Database Reset Script.
 */
async function reset() {
  console.log('[Reset] Loading configuration...')
  const config = await loadEnvironmentConfig()
  if (!config.database?.url) {
    throw new Error('Database configuration missing. Check your .env file.')
  }
  console.log('[Reset] Connecting to database...')
  const sql = postgres(config.database.url, {
    max: 1,
    onnotice: () => {}, // Silence "NOTICE: drop cascades..." logs
  })
  try {
    // Drop Schemas
    console.log('[Reset] Dropping schemas...')
    await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`
    await sql`DROP SCHEMA IF EXISTS public CASCADE`
    // Recreate Public Schema
    console.log('[Reset] Recreating public schema...')
    await sql`CREATE SCHEMA public`
    // Restore Standard Permissions
    // Matches the PostgreSQL 15+ default: PUBLIC can use the schema but not create objects in it.
    // Table grants for other roles are lost with the dropped schema; `npm run db:grant` re-applies them.
    console.log('[Reset] Restoring permissions...')
    await sql`GRANT USAGE ON SCHEMA public TO public`
    await sql`COMMENT ON SCHEMA public IS 'standard public schema'`
    // Verification Step
    const check = await sql`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name = 'public'
    `
    if (check.length === 0) {
      throw new Error('[Fatal] Script finished but public schema was NOT found.')
    }
    console.log('[Reset] Database wiped and verified successfully.')
  } catch (err) {
    console.error('[Reset] Failed to reset database:', err)
    process.exit(1)
  } finally {
    await sql.end()
  }
}

reset()
