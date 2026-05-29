import { sql, defineRelations } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core'
import { instanceStatusEnum, createHostSchema, defineHostRelations } from '@qiln/engine/server'

export const users = pgTable('users', {
  id: uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`),
  username: text('username').notNull().unique(),
  email: text('email').notNull().unique(),
  password: text('password').notNull(),
  avatar: text('avatar').notNull().default('default'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
})

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
})

// Instantiate the host infrastructure tables, passing in the Host's user ID column.
const hostTables = createHostSchema(users.id)

// Export enum for drizzle
export { instanceStatusEnum }

// Re-export for direct access if needed by routers/services
export const { instances } = hostTables

/**
 * The unified schema object containing all tables from both the Host and the Engine.
 * This is the single source of truth passed to the `drizzle()` constructor.
 */
export const schema = {
  // Host Tables
  users,
  sessions,
  // Infrastructure Tables
  instanceStatusEnum,
  ...hostTables,
} as const

// Export the type of the merged schema for use in other modules
export type AppSchema = typeof schema

/**
 * Defines ALL relations for the entire application using the Drizzle v1 API.
 * This merges Host-specific relations with Engine-provided relations.
 */
export const relations = defineRelations(schema, helpers => ({
  // Host Relations
  users: {
    sessions: helpers.many.sessions(),
    // One-to-many relation mapping users to their Incus instances
    instances: helpers.many.instances(),
  },
  sessions: {
    user: helpers.one.users({
      from: helpers.sessions.userId,
      to: helpers.users.id,
    }),
  },
  // Spread the host infrastructure relations
  ...defineHostRelations(helpers),
}))
