import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { CapsuleOperationSummarySchema } from '@qiln/core/server'
import { protectedProcedure, router } from '../../init'
import { handleEngineError } from '../../utils'

const CapsuleOperationIdentitySchema = z
  .object({
    operationId: z.uuid(),
  })
  .strict()

const CapsuleOperationListInputSchema = z
  .object({
    capsuleId: z.uuid(),
  })
  .strict()

export const capsuleOperationsRouter = router({
  get: protectedProcedure
    .input(CapsuleOperationIdentitySchema)
    .output(CapsuleOperationSummarySchema)
    .query(async ({ ctx, input }) => {
      try {
        const operation = await ctx.engine.capsuleOperations.get(ctx.user.id, input.operationId)
        if (!operation) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Capsule operation not found or access denied.',
          })
        }
        return operation
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),

  list: protectedProcedure
    .input(CapsuleOperationListInputSchema)
    .output(z.array(CapsuleOperationSummarySchema))
    .query(async ({ ctx, input }) => {
      try {
        return await ctx.engine.capsuleOperations.list(ctx.user.id, input.capsuleId)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),
})
