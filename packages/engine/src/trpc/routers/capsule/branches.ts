import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import {
  CapsuleBlueprintDigestSchema,
  CapsuleBranchCommandBaseSchema,
  CapsuleBranchNameSchema,
  CapsuleBranchStartReceiptSchema,
  CapsuleBranchStatusSchema,
  CapsuleBranchStopReceiptSchema,
} from '@qiln/core/server'
import { protectedProcedure, router } from '../../init'
import { createUserMutationIdentity } from '../../identity'
import { handleEngineError } from '../../utils'

export const CapsuleBranchSummarySchema = z
  .object({
    id: z.uuid(),
    capsuleId: z.uuid(),
    name: CapsuleBranchNameSchema,
    status: CapsuleBranchStatusSchema,
    isRootBranch: z.boolean(),
    cpu: z.string(),
    memory: z.string(),
    blueprintName: z.string(),
    blueprintDigest: CapsuleBlueprintDigestSchema,
    runtimeIp: z.string().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict()

const CapsuleBranchStateInputSchema = z
  .object({
    capsuleId: z.uuid(),
    name: CapsuleBranchNameSchema,
  })
  .strict()

const CapsuleBranchMutationInputSchema = CapsuleBranchCommandBaseSchema.pick({
  capsuleId: true,
  branchId: true,
  idempotencyKey: true,
}).strict()

export const capsuleBranchesRouter = router({
  list: protectedProcedure.output(z.array(CapsuleBranchSummarySchema)).query(async ({ ctx }) => {
    try {
      return await ctx.engine.capsuleBranches.list(ctx.user.id)
    } catch (error: unknown) {
      handleEngineError(error)
    }
  }),

  state: protectedProcedure
    .input(CapsuleBranchStateInputSchema)
    .output(CapsuleBranchSummarySchema)
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
    .input(CapsuleBranchMutationInputSchema)
    .output(CapsuleBranchStartReceiptSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const identity = createUserMutationIdentity(ctx.user)
        return await ctx.engine.capsuleBranches.start(identity, input)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),

  stop: protectedProcedure
    .input(CapsuleBranchMutationInputSchema)
    .output(CapsuleBranchStopReceiptSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const identity = createUserMutationIdentity(ctx.user)
        return await ctx.engine.capsuleBranches.stop(identity, input)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),
})
