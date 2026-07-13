import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { CapsuleBlueprintDigestSchema, CapsuleBranchNameSchema, CapsuleBranchStatusSchema, CapsuleCommandAckSchema } from '@qiln/core/server'
import { protectedProcedure, router } from '../../init'
import { handleEngineError } from '../../utils'

export const CapsuleBranchRuntimeItemSchema = z
  .object({
    id: z.uuid(),
    capsuleId: z.uuid(),
    name: CapsuleBranchNameSchema,
    status: CapsuleBranchStatusSchema,
    isRootBranch: z.boolean(),
    cpu: z.string(),
    memory: z.string(),
    blueprint: z.string(),
    blueprintDigest: CapsuleBlueprintDigestSchema,
    ip: z.string().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict()

const CapsuleBranchIdentitySchema = z
  .object({
    capsuleId: z.uuid(),
    name: CapsuleBranchNameSchema,
  })
  .strict()

export const capsuleBranchesRouter = router({
  list: protectedProcedure.output(z.array(CapsuleBranchRuntimeItemSchema)).query(async ({ ctx }) => {
    try {
      return await ctx.engine.capsuleBranches.list(ctx.user.id)
    } catch (error: unknown) {
      handleEngineError(error)
    }
  }),

  state: protectedProcedure
    .input(CapsuleBranchIdentitySchema)
    .output(CapsuleBranchRuntimeItemSchema)
    .query(async ({ ctx, input }) => {
      try {
        const branch = await ctx.engine.capsuleBranches.state(ctx.user.id, input.capsuleId, input.name)

        if (!branch) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Capsule branch not found or access denied.',
          })
        }

        return branch
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),

  start: protectedProcedure
    .input(CapsuleBranchIdentitySchema)
    .output(CapsuleCommandAckSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.engine.capsuleBranches.start(ctx.user.id, input.capsuleId, input.name)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),

  stop: protectedProcedure
    .input(CapsuleBranchIdentitySchema)
    .output(CapsuleCommandAckSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.engine.capsuleBranches.stop(ctx.user.id, input.capsuleId, input.name)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),
})
