import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'
import { capsuleTables } from './capsule'

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', {
    withTimezone: true,
    mode: 'date',
  }).notNull(),
})

/**
 * Host-owned API credentials bind one external agent actor and requester to an
 * optional capsule scope. The key secret is never persisted in plaintext.
 */
export const agentCredentials = pgTable(
  'agent_credentials',
  {
    id: uuid('id').primaryKey(),
    keyHash: text('key_hash').notNull(),
    agentActorId: uuid('agent_actor_id').notNull(),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    capsuleId: uuid('capsule_id').references(() => capsuleTables.capsules.id, {
      onDelete: 'restrict',
    }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .defaultNow(),
  },
  table => [
    index('agent_credentials_requested_by_user_idx').on(table.requestedByUserId),
    index('agent_credentials_capsule_idx').on(table.capsuleId),
    index('agent_credentials_active_idx').on(table.isActive),
  ],
)
