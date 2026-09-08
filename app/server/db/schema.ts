import { defineRelations } from 'drizzle-orm'
import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { defineCapsuleRelations, mergeRelationFragments } from '@qiln/core/server'
import { users } from '../../db/identity'
import { capsuleSchema, capsuleTables } from '../../db/capsule'

export { users }
export * from '../../db/capsule'

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

/**
 * Web runtime schema. SSH persistence is composed only by the SSH application
 * and the complete migration schema.
 */
export const schema = {
  users,
  sessions,
  agentCredentials,
  ...capsuleSchema,
} as const

/**
 * Defines Host and capsule-domain relations using the Drizzle v1 relations API.
 * Duplicate relation names fail during fragment composition.
 */
export const relations = defineRelations(schema, helpers =>
  mergeRelationFragments(
    {
      users: {
        sessions: helpers.many.sessions(),
        capsules: helpers.many.capsules(),
        capsuleBranches: helpers.many.capsuleBranches(),
        capsuleOperations: helpers.many.capsuleOperations(),
        capsuleOperationSteps: helpers.many.capsuleOperationSteps(),
        capsuleBranchResources: helpers.many.capsuleBranchResources(),
        agentCredentials: helpers.many.agentCredentials(),
      },
      sessions: {
        user: helpers.one.users({
          from: helpers.sessions.userId,
          to: helpers.users.id,
        }),
      },
      capsules: {
        agentCredentials: helpers.many.agentCredentials(),
      },
      agentCredentials: {
        requester: helpers.one.users({
          from: helpers.agentCredentials.requestedByUserId,
          to: helpers.users.id,
          optional: false,
        }),
        capsule: helpers.one.capsules({
          from: helpers.agentCredentials.capsuleId,
          to: helpers.capsules.id,
        }),
      },
    },
    defineCapsuleRelations(helpers),
  ),
)
