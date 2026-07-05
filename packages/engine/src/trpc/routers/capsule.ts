import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { CapsuleBranchNameSchema, CapsuleBranchStatusSchema, CapsuleCommandAckSchema, DEFAULT_CAPSULE_BLUEPRINT_NAME } from '@qiln/core/server'
import { router, protectedProcedure } from '../init'
import { handleEngineError } from '../utils'

export const CapsuleBranchItemSchema = z
  .object({
    id: z.uuid(),
    name: CapsuleBranchNameSchema,
    status: CapsuleBranchStatusSchema,
    cpu: z.string(),
    memory: z.string(),
    blueprint: z.string(),
    ip: z.string().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict()

export const capsuleRouter = router({
  list: protectedProcedure.output(z.array(CapsuleBranchItemSchema)).query(async ({ ctx }) => {
    try {
      return await ctx.engine.capsule.list(ctx.user.id)
    } catch (error: unknown) {
      handleEngineError(error)
    }
  }),

  state: protectedProcedure
    .input(
      z
        .object({
          name: CapsuleBranchNameSchema,
        })
        .strict(),
    )
    .output(CapsuleBranchItemSchema.nullable())
    .query(async ({ ctx, input }) => {
      try {
        const state = await ctx.engine.capsule.state(ctx.user.id, input.name)
        if (!state) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Capsule branch not found or access denied.' })
        }

        return state
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),

  create: protectedProcedure
    .input(
      z
        .object({
          name: CapsuleBranchNameSchema,
          blueprint: z.string().trim().min(1, 'Capsule blueprint name cannot be empty.').default(DEFAULT_CAPSULE_BLUEPRINT_NAME),
          cpu: z.string().trim().min(1, 'CPU limit cannot be empty.').default('4'),
          memory: z.string().trim().min(1, 'Memory limit cannot be empty.').default('4GB'),
        })
        .strict(),
    )
    .output(CapsuleCommandAckSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.engine.capsule.create(ctx.user.id, input)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),

  start: protectedProcedure
    .input(
      z
        .object({
          name: CapsuleBranchNameSchema,
        })
        .strict(),
    )
    .output(CapsuleCommandAckSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.engine.capsule.start(ctx.user.id, input.name)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),

  stop: protectedProcedure
    .input(
      z
        .object({
          name: CapsuleBranchNameSchema,
        })
        .strict(),
    )
    .output(CapsuleCommandAckSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.engine.capsule.stop(ctx.user.id, input.name)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),

  delete: protectedProcedure
    .input(
      z
        .object({
          name: CapsuleBranchNameSchema,
        })
        .strict(),
    )
    .output(CapsuleCommandAckSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.engine.capsule.delete(ctx.user.id, input.name)
      } catch (error: unknown) {
        handleEngineError(error)
      }
    }),
})
