import { z } from 'zod'
import {
  CapsuleArchiveOperationOutputSchema,
  CapsuleBlueprintDigestSchema,
  CapsuleBranchNameSchema,
  CapsuleCreateOutputSchema,
  CapsuleDestroyOperationOutputSchema,
  CapsuleOperationIdempotencyKeySchema,
  CapsuleUnarchiveOperationOutputSchema,
  DEFAULT_CAPSULE_BLUEPRINT_NAME,
} from '@qiln/core/server'
import { protectedProcedure, router } from '../../init'
import { handleEngineError } from '../../utils'
import { capsuleBranchesRouter } from './branches'
import { capsuleOperationsRouter } from './operations'
import { capsuleSnapshotsRouter } from './snapshots'

const CapsuleOperationMutationInputSchema = z
  .object({
    capsuleId: z.uuid(),
    idempotencyKey: CapsuleOperationIdempotencyKeySchema,
  })
  .strict()

const CapsuleCreateMutationInputSchema = z
  .object({
    rootBranchName: CapsuleBranchNameSchema,
    idempotencyKey: CapsuleOperationIdempotencyKeySchema,
    blueprintName: z.string().trim().min(1, 'Capsule blueprint name cannot be empty.').default(DEFAULT_CAPSULE_BLUEPRINT_NAME),
    blueprintDigest: CapsuleBlueprintDigestSchema,
    cpu: z.string().trim().min(1, 'CPU limit cannot be empty.').default('4'),
    memory: z.string().trim().min(1, 'Memory limit cannot be empty.').default('4GB'),
  })
  .strict()

export const capsuleRouter = router({
  create: protectedProcedure
    .input(CapsuleCreateMutationInputSchema)
    .output(CapsuleCreateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.engine.capsuleOperations.create(ctx.user.id, input)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),

  archive: protectedProcedure
    .input(CapsuleOperationMutationInputSchema)
    .output(CapsuleArchiveOperationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.engine.capsuleOperations.archive(ctx.user.id, input.capsuleId, input.idempotencyKey)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),

  unarchive: protectedProcedure
    .input(CapsuleOperationMutationInputSchema)
    .output(CapsuleUnarchiveOperationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.engine.capsuleOperations.unarchive(ctx.user.id, input.capsuleId, input.idempotencyKey)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),

  destroy: protectedProcedure
    .input(CapsuleOperationMutationInputSchema)
    .output(CapsuleDestroyOperationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.engine.capsuleOperations.destroy(ctx.user.id, input.capsuleId, input.idempotencyKey)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),

  branches: capsuleBranchesRouter,
  operations: capsuleOperationsRouter,
  snapshots: capsuleSnapshotsRouter,
})
