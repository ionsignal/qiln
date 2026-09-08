import { sql } from 'drizzle-orm'
import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Shared physical user identity. Web owns authentication; SSH consumes only the
 * identity and administrator columns required by its policy.
 */
export const users = pgTable('users', {
  id: uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`),
  username: text('username').notNull().unique(),
  email: text('email').notNull().unique(),
  password: text('password').notNull(),
  avatar: text('avatar').notNull().default('default'),
  isAdmin: boolean('is_admin').notNull().default(false),
  createdAt: timestamp('created_at', {
    withTimezone: true,
    mode: 'date',
  })
    .notNull()
    .defaultNow(),
})
