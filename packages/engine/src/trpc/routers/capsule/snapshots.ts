import { z } from 'zod'
import { CapsuleSnapshotListOutputSchema } from '@qiln/core/server'
import { protectedProcedure, router } from '../../init'
import { handleEngineError } from '../../utils'

const CapsuleSnapshotListInputSchema = z
  .object({
    capsuleId: z.uuid(),
  })
  .strict()

/**
 * Read-only client boundary for complete committed capsule snapshot history.
 *
 * Owner identity is derived from authenticated tRPC context and is never
 * accepted from browser input. Snapshot Capture and detailed evidence access
 * remain unavailable through this router.
 */
export const capsuleSnapshotsRouter = router({
  list: protectedProcedure
    .input(CapsuleSnapshotListInputSchema)
    .output(CapsuleSnapshotListOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await ctx.engine.capsuleSnapshots.list(ctx.user.id, input.capsuleId)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),
})
