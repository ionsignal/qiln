import { z } from 'zod'
import { CapsuleSnapshotListOutputSchema } from '@qiln/core/server'
import { protectedProcedure, router } from '../../init'
import { handleEngineError } from '../../utils'

export const capsuleSnapshotsRouter = router({
  list: protectedProcedure
    .input(
      z
        .object({
          capsuleId: z.uuid(),
        })
        .strict(),
    )
    .output(CapsuleSnapshotListOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await ctx.engine.capsuleSnapshots.list(ctx.user.id, input.capsuleId)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),
})
