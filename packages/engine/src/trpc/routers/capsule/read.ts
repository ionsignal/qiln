import { CapsuleDetailInputSchema, CapsuleDetailSchema, CapsuleListOutputSchema } from '@qiln/core/server'
import { protectedProcedure, router } from '../../init'
import { handleEngineError } from '../../utils'

const CapsuleDetailRequestSchema = CapsuleDetailInputSchema.pick({
  capsuleId: true,
  branchId: true,
}).strict()

/**
 * Capsule-first reads preserve Worker availability semantics without deriving
 * capsule state from operational branch lists. Browser input never supplies an
 * owner target, and an omitted branch selector remains omitted.
 */
export const capsuleReadRouter = router({
  list: protectedProcedure.output(CapsuleListOutputSchema).query(async ({ ctx }) => {
    try {
      return await ctx.engine.capsuleRead.list(ctx.user.id)
    } catch (error: unknown) {
      handleEngineError(error)
    }
  }),

  detail: protectedProcedure
    .input(CapsuleDetailRequestSchema)
    .output(CapsuleDetailSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await ctx.engine.capsuleRead.detail(ctx.user.id, input)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),
})
