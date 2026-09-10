import {
  CapsuleSnapshotCreateInputSchema,
  CapsuleSnapshotCreateOutputSchema,
  CapsuleSnapshotListOutputSchema,
  CapsuleSnapshotsListInputSchema,
} from '@qiln/core/server'
import { protectedProcedure, router } from '../../init'
import { createUserMutationIdentity } from '../../identity'
import { handleEngineError } from '../../utils'

const CapsuleSnapshotListInputSchema = CapsuleSnapshotsListInputSchema.pick({
  capsuleId: true,
}).strict()

const CapsuleSnapshotCreateMutationInputSchema = CapsuleSnapshotCreateInputSchema.pick({
  capsuleId: true,
  sourceBranchId: true,
  idempotencyKey: true,
}).strict()

/**
 * Client boundary for committed capsule snapshot history and Create Snapshot
 * submission.
 *
 * Owner identity and operation actor provenance are derived from authenticated
 * tRPC context. Browser input cannot select provider identities, restoration
 * pins, or weaken Worker-owned snapshot fences. Every returned snapshot must
 * satisfy the same committed restoration contract.
 *
 * Create returns a durable operation receipt. Clients must refetch
 * authoritative operation, branch, and committed snapshot state after receiving
 * invalidation events or reconnecting.
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

  create: protectedProcedure
    .input(CapsuleSnapshotCreateMutationInputSchema)
    .output(CapsuleSnapshotCreateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const identity = createUserMutationIdentity(ctx.user)
        return await ctx.engine.capsuleSnapshots.create(identity, input)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),
})
