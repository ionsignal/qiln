import { z } from 'zod'
import {
  CapsuleArchiveOutputSchema,
  CapsuleBlueprintDigestSchema,
  CapsuleBootstrapCreateOutputSchema,
  CapsuleBranchNameSchema,
  CapsuleDestroyOutputSchema,
  CapsuleLifecycleIdempotencyKeySchema,
  CapsuleUnarchiveOutputSchema,
  DEFAULT_CAPSULE_BLUEPRINT_NAME,
} from '@qiln/core/server'
import { protectedProcedure, router } from '../../init'
import { handleEngineError } from '../../utils'
import { capsuleBranchesRouter } from './branches'
import { capsuleSnapshotsRouter } from './snapshots'

const CapsuleLifecycleMutationInputSchema = z
  .object({
    capsuleId: z.uuid(),
    idempotencyKey: CapsuleLifecycleIdempotencyKeySchema,
  })
  .strict()

export const capsuleRouter = router({
  create: protectedProcedure
    .input(
      z
        .object({
          rootBranchName: CapsuleBranchNameSchema,
          idempotencyKey: CapsuleLifecycleIdempotencyKeySchema,
          blueprintName: z.string().trim().min(1, 'Capsule blueprint name cannot be empty.').default(DEFAULT_CAPSULE_BLUEPRINT_NAME),
          blueprintDigest: CapsuleBlueprintDigestSchema,
          cpu: z.string().trim().min(1, 'CPU limit cannot be empty.').default('4'),
          memory: z.string().trim().min(1, 'Memory limit cannot be empty.').default('4GB'),
        })
        .strict(),
    )
    .output(CapsuleBootstrapCreateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.engine.capsuleLifecycle.create(ctx.user.id, input)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),

  archive: protectedProcedure
    .input(CapsuleLifecycleMutationInputSchema)
    .output(CapsuleArchiveOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.engine.capsuleLifecycle.archive(ctx.user.id, input.capsuleId, input.idempotencyKey)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),

  unarchive: protectedProcedure
    .input(CapsuleLifecycleMutationInputSchema)
    .output(CapsuleUnarchiveOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.engine.capsuleLifecycle.unarchive(ctx.user.id, input.capsuleId, input.idempotencyKey)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),

  destroy: protectedProcedure
    .input(CapsuleLifecycleMutationInputSchema)
    .output(CapsuleDestroyOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.engine.capsuleLifecycle.destroy(ctx.user.id, input.capsuleId, input.idempotencyKey)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),

  branches: capsuleBranchesRouter,
  snapshots: capsuleSnapshotsRouter,
})
