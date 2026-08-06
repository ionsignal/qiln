import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { AgentCredentialNotFoundError, AgentCredentialService } from '@server/agent/credentials'
import { protectedProcedure, router } from '@server/trpc/procedures'

const AgentCredentialSummarySchema = z
  .object({
    id: z.uuid(),
    agentActorId: z.uuid(),
    capsuleId: z.uuid().nullable(),
    isActive: z.boolean(),
    createdAt: z.date(),
  })
  .strict()

const AgentCredentialIssueInputSchema = z
  .object({
    capsuleId: z.uuid(),
  })
  .strict()

const AgentCredentialIssueOutputSchema = AgentCredentialSummarySchema.extend({
  capsuleId: z.uuid(),
  isActive: z.literal(true),
  apiKey: z.string().min(1).max(512),
}).strict()

const AgentCredentialRevokeInputSchema = z
  .object({
    credentialId: z.uuid(),
  })
  .strict()

function toNotFound(error: unknown): never {
  if (error instanceof AgentCredentialNotFoundError) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: error.message,
    })
  }
  throw error
}

/**
 * Host-authenticated credential administration for external Qiln agents.
 *
 * These procedures are intentionally separate from the Bearer REST boundary
 * used by @qiln/agent. Only `issue` returns a plaintext API key, and that key
 * is never available from list or revoke responses.
 */
export const agentRouter = router({
  issue: protectedProcedure
    .input(AgentCredentialIssueInputSchema)
    .output(AgentCredentialIssueOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await new AgentCredentialService(ctx.db).issue(ctx.user.id, input.capsuleId)
      } catch (error: unknown) {
        toNotFound(error)
      }
    }),

  list: protectedProcedure.output(z.array(AgentCredentialSummarySchema)).query(async ({ ctx }) => {
    return await new AgentCredentialService(ctx.db).list(ctx.user.id)
  }),

  revoke: protectedProcedure
    .input(AgentCredentialRevokeInputSchema)
    .output(AgentCredentialSummarySchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await new AgentCredentialService(ctx.db).revoke(ctx.user.id, input.credentialId)
      } catch (error: unknown) {
        toNotFound(error)
      }
    }),
})
