import bcrypt from 'bcrypt'
import { randomBytes } from 'node:crypto'
import { loadConfig } from 'c12'
import { createDataLayer } from '@server/db'
import { users } from '@server/db/schema'
import type { EnvironmentConfig } from '@/types'

// Deterministic IDs for the default users
const SYSTEM_USER_ID = '0193f123-4567-7000-ab12-34567890abcd'
const OLIVER_USER_ID = '0193f123-4567-7000-ab12-34567890abcf'

const rootUserData = [
  {
    id: SYSTEM_USER_ID,
    username: 'System',
    avatar: 'system',
    email: 'hq@ionsignal.com',
  },
  {
    id: OLIVER_USER_ID,
    username: 'Oliver D',
    avatar: 'oliver',
    email: 'oliver@ionsignal.com',
  },
]

async function seed() {
  console.log('[Seed] Loading configuration...')
  const { config } = await loadConfig<EnvironmentConfig>({
    configFile: 'app/dist/server/config',
    dotenv: true,
  })
  if (!config || !config.database?.url) {
    throw new Error('Database configuration missing. Check your .env file.')
  }
  // Initialize Data Layer (DB + Broker)
  // We destructure 'close' to ensure we shut down the Postgres client properly
  const { db, close } = createDataLayer(config.database.url)
  const isDev = process.env.NODE_ENV !== 'production'
  const credentialsLog: string[] = []
  try {
    // Seed Users
    console.log('[Seed] Seeding users...')
    for (const user of rootUserData) {
      // Generate a secure random password (16 characters hex)
      const randomPassword = randomBytes(8).toString('hex')
      const hashedPassword = await bcrypt.hash(randomPassword, 12)
      // Upsert: Create if missing, update if exists (resets password)
      await db
        .insert(users)
        .values({
          ...user,
          password: hashedPassword,
        })
        .onConflictDoUpdate({
          target: users.id,
          set: {
            username: user.username,
            email: user.email,
            password: hashedPassword,
            avatar: user.avatar,
          },
        })
        
      if (isDev) {
        credentialsLog.push(`[Seed] ${user.username.padEnd(15)} | ${user.email.padEnd(25)} | ${randomPassword}`)
      }
    }
    console.log('[Seed] Database hydration complete.')
    if (isDev && credentialsLog.length > 0) {
      console.log('[Seed] Development credentials generated:')
      credentialsLog.forEach(log => console.log(log))
      console.log('')
    } else {
      console.log('[Seed] Root users updated.')
    }
  } catch (err) {
    console.error('[Seed] Error during seeding:', err)
    process.exit(1)
  } finally {
    console.log('[Seed] Closing connections...')
    await close()
  }
}

seed().catch(error => {
  console.error('[Seed] Fatal error:', error)
  process.exit(1)
})
