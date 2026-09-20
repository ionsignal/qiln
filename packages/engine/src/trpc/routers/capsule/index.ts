import { z } from 'zod'
import {
  CapsuleArchiveOperationOutputSchema,
  CapsuleBlueprintDigestSchema,
  CapsuleBranchNameSchema,
  CapsuleCreateOutputSchema,
  CapsuleDestroyOperationOutputSchema,
  CapsuleDestroyOptionsSchema,
  CapsuleOperationIdempotencyKeySchema,
  CapsuleUnarchiveOperationOutputSchema,
  DEFAULT_CAPSULE_BLUEPRINT_NAME,
} from '@qiln/core/server'
import { protectedProcedure, router, t } from '../../init'
import { createUserMutationIdentity } from '../../identity'
import { handleEngineError } from '../../utils'
import { capsuleBranchesRouter } from './branches'
import { capsuleOperationsRouter } from './operations'
import { capsuleReadRouter } from './read'
import { capsuleSnapshotsRouter } from './snapshots'

const CapsuleLifecycleRequestSchema = z
  .object({
    capsuleId: z.uuid(),
    idempotencyKey: CapsuleOperationIdempotencyKeySchema,
  })
  .strict()

const CapsuleDestroyMutationInputSchema = z.discriminatedUnion('force', [
  CapsuleLifecycleRequestSchema.extend(CapsuleDestroyOptionsSchema.options[0].shape).strict(),
  CapsuleLifecycleRequestSchema.extend(CapsuleDestroyOptionsSchema.options[1].shape).strict(),
])

const CapsuleCreateMutationInputSchema = z
  .object({
    rootBranchName: CapsuleBranchNameSchema,
    idempotencyKey: CapsuleOperationIdempotencyKeySchema,
    blueprintName: z
      .string()
      .trim()
      .min(1, 'Capsule blueprint name cannot be empty.')
      .default(DEFAULT_CAPSULE_BLUEPRINT_NAME),
    blueprintDigest: CapsuleBlueprintDigestSchema,
    cpu: z.string().trim().min(1, 'CPU limit cannot be empty.').default('4'),
    memory: z.string().trim().min(1, 'Memory limit cannot be empty.').default('4GB'),
  })
  .strict()

const capsuleOperationsAndBranchesRouter = router({
  create: protectedProcedure
    .input(CapsuleCreateMutationInputSchema)
    .output(CapsuleCreateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const identity = createUserMutationIdentity(ctx.user)
        return await ctx.engine.capsuleOperations.create(identity, input)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),

  archive: protectedProcedure
    .input(CapsuleLifecycleRequestSchema)
    .output(CapsuleArchiveOperationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const identity = createUserMutationIdentity(ctx.user)
        return await ctx.engine.capsuleOperations.archive(identity, input.capsuleId, input.idempotencyKey)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),

  unarchive: protectedProcedure
    .input(CapsuleLifecycleRequestSchema)
    .output(CapsuleUnarchiveOperationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const identity = createUserMutationIdentity(ctx.user)
        return await ctx.engine.capsuleOperations.unarchive(identity, input.capsuleId, input.idempotencyKey)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),

  destroy: protectedProcedure
    .input(CapsuleDestroyMutationInputSchema)
    .output(CapsuleDestroyOperationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const identity = createUserMutationIdentity(ctx.user)
        return await ctx.engine.capsuleOperations.destroy(identity, input)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),

  branches: capsuleBranchesRouter,
  operations: capsuleOperationsRouter,
  snapshots: capsuleSnapshotsRouter,
})
export const capsuleRouter = t.mergeRouters(capsuleReadRouter, capsuleOperationsAndBranchesRouter)
