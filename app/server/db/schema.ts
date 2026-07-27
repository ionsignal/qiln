import { sql, defineRelations } from 'drizzle-orm'
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core'
import {
  capsuleActorTypeEnum,
  capsuleArtifactEntryTypeEnum,
  capsuleBranchResourceCleanupPolicyEnum,
  capsuleBranchResourceStatusEnum,
  capsuleBranchResourceTypeEnum,
  capsuleBranchStatusEnum,
  capsuleLifecycleStatusEnum,
  capsuleOperationStatusEnum,
  capsuleOperationStepStatusEnum,
  capsuleOperationTypeEnum,
  capsuleRouteAliasStatusEnum,
  capsuleRouteExposureEnum,
  capsuleRouteMethodEnum,
  capsuleRouteProviderEnum,
  capsuleRouteProviderStatusEnum,
  capsuleRouteRevisionActionEnum,
  capsuleRouteRevisionStatusEnum,
  capsuleSnapshotCaptureResourceStatusEnum,
  capsuleSnapshotDependencyDigestKindEnum,
  capsuleSnapshotDependencyKindEnum,
  capsuleSnapshotGitRemoteTransportEnum,
  capsuleSnapshotModeEnum,
  capsuleSnapshotResourceKindEnum,
  capsuleSnapshotResourceProviderEnum,
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

export const capsuleTables = createCapsuleSchema(users.id)

export {
  capsuleActorTypeEnum,
  capsuleArtifactEntryTypeEnum,
  capsuleBranchResourceCleanupPolicyEnum,
  capsuleBranchResourceStatusEnum,
  capsuleBranchResourceTypeEnum,
  capsuleBranchStatusEnum,
  capsuleLifecycleStatusEnum,
  capsuleOperationStatusEnum,
  capsuleOperationStepStatusEnum,
  capsuleOperationTypeEnum,
  capsuleRouteAliasStatusEnum,
  capsuleRouteExposureEnum,
  capsuleRouteMethodEnum,
  capsuleRouteProviderEnum,
  capsuleRouteProviderStatusEnum,
  capsuleRouteRevisionActionEnum,
  capsuleRouteRevisionStatusEnum,
  capsuleSnapshotCaptureResourceStatusEnum,
  capsuleSnapshotDependencyDigestKindEnum,
  capsuleSnapshotDependencyKindEnum,
  capsuleSnapshotGitRemoteTransportEnum,
  capsuleSnapshotModeEnum,
  capsuleSnapshotResourceKindEnum,
  capsuleSnapshotResourceProviderEnum,
}

export const {
  capsules,
  capsuleBranches,
  capsuleOperations,
  capsuleCreateOperations,
  capsuleOperationSteps,
  capsuleBranchResources,
  capsuleSnapshots,
  capsuleArtifactManifests,
  capsuleArtifactManifestRoots,
  capsuleArtifactEntries,
  capsuleSnapshotGitRepositories,
  capsuleSnapshotGitRemotes,
  capsuleSnapshotDependencyReferences,
  capsuleSnapshotResourceReferences,
  capsuleSnapshotCaptureOperations,
  capsuleSnapshotCaptureResources,
  capsuleRouteAliases,
  capsuleRouteHeads,
  capsuleRouteRevisions,
  capsuleRouteOperations,
  capsuleRouteProviderApplications,
} = capsuleTables

/**
 * Unified physical schema consumed by Drizzle.
 */
export const schema = {
  users,
  sessions,
  capsuleActorTypeEnum,
  capsuleArtifactEntryTypeEnum,
  capsuleBranchStatusEnum,
  capsuleBranchResourceCleanupPolicyEnum,
  capsuleBranchResourceStatusEnum,
  capsuleBranchResourceTypeEnum,
  capsuleLifecycleStatusEnum,
  capsuleOperationStatusEnum,
  capsuleOperationStepStatusEnum,
  capsuleOperationTypeEnum,
  capsuleRouteAliasStatusEnum,
  capsuleRouteExposureEnum,
  capsuleRouteMethodEnum,
  capsuleRouteProviderEnum,
  capsuleRouteProviderStatusEnum,
  capsuleRouteRevisionActionEnum,
  capsuleRouteRevisionStatusEnum,
  capsuleSnapshotCaptureResourceStatusEnum,
  capsuleSnapshotDependencyDigestKindEnum,
  capsuleSnapshotDependencyKindEnum,
  capsuleSnapshotGitRemoteTransportEnum,
  capsuleSnapshotModeEnum,
  capsuleSnapshotResourceKindEnum,
  capsuleSnapshotResourceProviderEnum,
  ...capsuleTables,
} as const

/**
 * Defines all host and capsule-domain relations using the Drizzle v1 relations
 * API. Duplicate relation names fail during fragment composition.
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
