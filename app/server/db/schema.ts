import { sql, defineRelations } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core'
import {
  capsuleBranchStatusEnum,
  capsuleOperationCleanupPolicyEnum,
  capsuleOperationResourceStatusEnum,
  capsuleOperationResourceTypeEnum,
  capsuleOperationStatusEnum,
  capsuleOperationTypeEnum,
  createCapsuleSchema,
  defineCapsuleRelations,
  mergeRelationFragments,
} from '@qiln/core/server'

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

// Instantiate the shared capsule tables, passing in the `host` user ID column.
const capsuleTables = createCapsuleSchema(users.id)

export {
  capsuleBranchStatusEnum,
  capsuleOperationCleanupPolicyEnum,
  capsuleOperationResourceStatusEnum,
  capsuleOperationResourceTypeEnum,
  capsuleOperationStatusEnum,
  capsuleOperationTypeEnum,
}

export const { capsuleBranches, capsuleOperations, capsuleOperationResources } = capsuleTables

/**
 * The unified schema object containing all tables from both the host and shared core fragments.
 * This is the single source of truth passed to the `drizzle()` constructor.
 */
export const schema = {
  // host
  users,
  sessions,
  // capsule enums
  capsuleBranchStatusEnum,
  capsuleOperationTypeEnum,
  capsuleOperationStatusEnum,
  capsuleOperationResourceTypeEnum,
  capsuleOperationResourceStatusEnum,
  capsuleOperationCleanupPolicyEnum,
  // capsule tables
  ...capsuleTables,
} as const

// Export the type of the merged schema for use in other modules.
export type AppSchema = typeof schema

/**
 * Defines ALL relations for the entire application using the Drizzle v1 API.
 * This merges Host-specific relations with Core-provided capsule relations.
 */
export const relations = defineRelations(schema, helpers =>
  mergeRelationFragments(
    {
      // host relations
      users: {
        sessions: helpers.many.sessions(),
        capsuleBranches: helpers.many.capsuleBranches(),
        capsuleOperations: helpers.many.capsuleOperations(),
        capsuleOperationResources: helpers.many.capsuleOperationResources(),
      },
      sessions: {
        user: helpers.one.users({
          from: helpers.sessions.userId,
          to: helpers.users.id,
        }),
      },
    },
    // capsule relations
    defineCapsuleRelations(helpers),
  ),
)
