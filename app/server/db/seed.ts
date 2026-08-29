import bcrypt from 'bcrypt'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { createAgentKey } from '@server/agent/key'
import { loadEnvironmentConfig } from '@server/env'
import { createDataLayer } from '@server/db'
import { agentCredentials, users } from '@server/db/schema'

// Deterministic IDs for the default users
const SYSTEM_USER_ID = '0193f123-4567-7000-ab12-34567890abcd'
const OLIVER_USER_ID = '0193f123-4567-7000-ab12-34567890abcf'
const SYSTEM_AGENT_ACTOR_ID = '0193f123-4567-7000-ab12-34567890abd1'
const SYSTEM_AGENT_CREDENTIAL_ID = '0193f123-4567-7000-ab12-34567890abd2'

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
  const config = await loadEnvironmentConfig()
  if (!config.database?.url) {
    throw new Error('Database configuration missing. Check your .env file.')
  }
  // Initialize Data Layer (DB + Broker)
  // We destructure 'close' to ensure we shut down the Postgres client properly
  const { db, close } = createDataLayer(config.database.url)
  const isDev = process.env.NODE_ENV !== 'production'
  const credentialsLog: string[] = []
  const agentCredentialLog: string[] = []
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
    const [existingAgentCredential] = await db
      .select({
        id: agentCredentials.id,
      })
      .from(agentCredentials)
      .where(eq(agentCredentials.id, SYSTEM_AGENT_CREDENTIAL_ID))
      .limit(1)
    if (!existingAgentCredential) {
      const generatedKey = await createAgentKey(SYSTEM_AGENT_CREDENTIAL_ID)
      const [createdAgentCredential] = await db
        .insert(agentCredentials)
        .values({
          id: SYSTEM_AGENT_CREDENTIAL_ID,
          keyHash: generatedKey.keyHash,
          agentActorId: SYSTEM_AGENT_ACTOR_ID,
          requestedByUserId: SYSTEM_USER_ID,
          capsuleId: null,
          isActive: true,
        })
        .onConflictDoNothing()
        .returning({
          id: agentCredentials.id,
        })
      if (createdAgentCredential && isDev) {
        agentCredentialLog.push(
          `[Seed] System agent credential | actor ${SYSTEM_AGENT_ACTOR_ID} | key ${generatedKey.key}`,
        )
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
    if (agentCredentialLog.length > 0) {
      console.log('[Seed] Agent API key generated once. Store it outside Qiln:')
      agentCredentialLog.forEach(log => console.log(log))
      console.log('')
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
