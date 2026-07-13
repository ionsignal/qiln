import { sql, defineRelations } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core'
import {
  capsuleBranchResourceCleanupPolicyEnum,
  capsuleBranchResourceStatusEnum,
  capsuleBranchResourceTypeEnum,
  capsuleBranchStatusEnum,
  capsuleLifecycleOperationStatusEnum,
  capsuleLifecycleOperationStepStatusEnum,
  capsuleLifecycleOperationTypeEnum,
  capsuleLifecycleStatusEnum,
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
  createdAt: timestamp('created_at', {
    withTimezone: true,
    mode: 'date',
  })
    .notNull()
    .defaultNow(),
})

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

const capsuleTables = createCapsuleSchema(users.id)

export {
  capsuleLifecycleStatusEnum,
  capsuleLifecycleOperationTypeEnum,
  capsuleLifecycleOperationStatusEnum,
  capsuleLifecycleOperationStepStatusEnum,
  capsuleBranchResourceCleanupPolicyEnum,
  capsuleBranchResourceStatusEnum,
  capsuleBranchResourceTypeEnum,
  capsuleBranchStatusEnum,
}

export const {
  capsules,
  capsuleBranches,
  capsuleLifecycleOperations,
  capsuleLifecycleOperationSteps,
  capsuleBranchResources,
  capsuleSnapshots,
} = capsuleTables

/**
 * Unified physical schema consumed by Drizzle.
 */
export const schema = {
  users,
  sessions,
  capsuleLifecycleStatusEnum,
  capsuleBranchStatusEnum,
  capsuleLifecycleOperationTypeEnum,
  capsuleLifecycleOperationStatusEnum,
  capsuleLifecycleOperationStepStatusEnum,
  capsuleBranchResourceTypeEnum,
  capsuleBranchResourceStatusEnum,
  capsuleBranchResourceCleanupPolicyEnum,
  ...capsuleTables,
} as const

export type AppSchema = typeof schema

/**
 * Defines all host and Core capsule relations using the Drizzle v1 relations
 * API. Duplicate relation names fail during fragment composition.
 */
export const relations = defineRelations(schema, helpers =>
  mergeRelationFragments(
    {
      users: {
        sessions: helpers.many.sessions(),
        capsules: helpers.many.capsules(),
        capsuleBranches: helpers.many.capsuleBranches(),
        capsuleLifecycleOperations: helpers.many.capsuleLifecycleOperations(),
        capsuleLifecycleOperationSteps: helpers.many.capsuleLifecycleOperationSteps(),
        capsuleBranchResources: helpers.many.capsuleBranchResources(),
      },
      sessions: {
        user: helpers.one.users({
          from: helpers.sessions.userId,
          to: helpers.users.id,
        }),
      },
    },
    defineCapsuleRelations(helpers),
  ),
)
