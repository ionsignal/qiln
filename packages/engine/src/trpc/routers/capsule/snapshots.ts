import { z } from 'zod'
import {
  CapsuleOperationIdempotencyKeySchema,
  CapsuleSnapshotCaptureOutputSchema,
  CapsuleSnapshotListOutputSchema,
} from '@qiln/core/server'
import { protectedProcedure, router } from '../../init'
import { createUserMutationIdentity } from '../../identity'
import { handleEngineError } from '../../utils'

const CapsuleSnapshotListInputSchema = z
  .object({
    capsuleId: z.uuid(),
    includeExperimental: z.boolean().default(false),
  })
  .strict()

const CapsuleSnapshotCaptureInputSchema = z
  .object({
    capsuleId: z.uuid(),
    sourceBranchId: z.uuid(),
    idempotencyKey: CapsuleOperationIdempotencyKeySchema,
  })
  .strict()

/**
 * Client boundary for committed capsule snapshot history and experimental
 * Snapshot Capture submission.
 *
 * Owner identity and operation actor provenance are derived from authenticated
 * tRPC context. Browser input cannot select a capture mode, provide policy
 * evidence, identify provider resources, or weaken Worker-owned capture
 * fences.
 *
 * Capture returns a durable operation receipt. Clients must refetch
 * authoritative operation, branch, and committed snapshot state after receiving
 * invalidation events or reconnecting.
 */
export const capsuleSnapshotsRouter = router({
  list: protectedProcedure
    .input(CapsuleSnapshotListInputSchema)
    .output(CapsuleSnapshotListOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await ctx.engine.capsuleSnapshots.list(ctx.user.id, input.capsuleId, {
          includeExperimental: input.includeExperimental,
        })
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),

  capture: protectedProcedure
    .input(CapsuleSnapshotCaptureInputSchema)
    .output(CapsuleSnapshotCaptureOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const identity = createUserMutationIdentity(ctx.user)
        return await ctx.engine.capsuleSnapshots.capture(identity, input)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),
})
