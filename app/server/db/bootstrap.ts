import bcrypt from 'bcrypt'
import { readFile, unlink } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { createDatabase } from '@server/db'
import { loadEnvironmentConfig } from '@server/env'
import { users } from '@/db/users'

const adminSchema = z.strictObject({
  username: z.string().min(1),
  email: z.email(),
  password: z.string().min(12),
})

/**
 * Creates the first administrator from the one-shot file that the installer
 * pushed into the guest. The file is unlinked as soon as it is read, so a failed
 * attempt never leaves the password behind. Conflicts fail loudly, an existing
 * administrator makes this a no-op, and no password is ever reset.
 */
async function bootstrap() {
  const file = process.env.QILN_BOOTSTRAP_ADMIN_FILE
  if (!file) {
    throw new Error('QILN_BOOTSTRAP_ADMIN_FILE is not set.')
  }
  const text = await readFile(file, 'utf8')
  await unlink(file)
  console.log('[Bootstrap] Loading configuration...')
  const config = await loadEnvironmentConfig()
  const { db, close } = createDatabase(config.database.url, { queries: false })
  try {
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.isAdmin, true)).limit(1)
    if (existing) {
      console.log('[Bootstrap] An administrator already exists. Nothing was created.')
      return
    }
    const admin = adminSchema.parse(JSON.parse(text))
    await db.insert(users).values({
      username: admin.username,
      email: admin.email,
      password: await bcrypt.hash(admin.password, 12),
      isAdmin: true,
    })
    console.log(`[Bootstrap] Administrator '${admin.username}' created.`)
  } catch (error) {
    console.error('[Bootstrap] Failed to create the first administrator:', error)
    process.exitCode = 1
  } finally {
    await close()
  }
}

bootstrap().catch(error => {
  console.error('[Bootstrap] Fatal error:', error)
  process.exit(1)
})
