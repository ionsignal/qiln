import { defineRelations } from 'drizzle-orm'
import { defineCapsuleRelations, mergeRelationFragments } from '@qiln/core/server'
import { webSchema } from '@/db/web'

/**
 * Defines Host and capsule-domain relations using the Drizzle v1 relations API.
 * Duplicate relation names fail during fragment composition.
 */
export const relations = defineRelations(webSchema, helpers =>
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
