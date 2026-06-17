import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { router, protectedProcedure } from '../init'
import { handleHostError } from '../utils'

// Strict validation for Incus container names to prevent daemon errors.
const ContainerNameSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,48}[a-zA-Z0-9])?$/,
    'Container name must be alphanumeric, can contain hyphens, but cannot start or end with a hyphen.',
  )

export const instanceRouter = router({
  list: protectedProcedure
    .output(
      z.array(
        z.object({
          name: z.string(),
          status: z.string(),
          cpu: z.string(),
          memory: z.string(),
          definition: z.string(),
          //
          // TODO: this needs to become a fat object that works
          // for both VesselCard and Instance Card
          //
          // displayName: z.string(), // Added from Registry
          // ports: z.array(z.object({ // Added from Registry
          //   name: z.string(),
          //   port: z.number(),
          //   protocol: z.enum(['tcp', 'udp'])
          // }))
        }),
      ),
    )
    .query(async ({ ctx }) => {
      try {
        return await ctx.host.instance.list(ctx.user.id)
      } catch (error: unknown) {
        handleHostError(error)
      }
    }),

  state: protectedProcedure
    .input(
      z.object({
        name: ContainerNameSchema,
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        const state = await ctx.host.instance.state(ctx.user.id, input.name)
        if (!state) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Instance not found or access denied.' })
        }
        return state
      } catch (error: unknown) {
        handleHostError(error)
      }
    }),

  create: protectedProcedure
    .input(
      z.object({
        name: ContainerNameSchema,
        definition: z.string().trim().min(1, 'Definition name cannot be empty.').default('qiln-n8n-comfyui'),
        cpu: z.string().default('4'),
        memory: z.string().default('4GB'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await ctx.host.instance.create(ctx.user.id, input.name, input.definition, input.cpu, input.memory)
        if (!result.success) {
          throw new TRPCError({ code: 'CONFLICT', message: 'An instance with this name already exists.' })
        }
        return { success: true }
      } catch (error: unknown) {
        handleHostError(error)
      }
    }),

  start: protectedProcedure
    .input(
      z.object({
        name: ContainerNameSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await ctx.host.instance.start(ctx.user.id, input.name)
        if (!result.success) {
          if (result.reason === 'INVALID_STATE_TRANSITION') {
            throw new TRPCError({ code: 'CONFLICT', message: 'Instance is not in a startable state (must be offline).' })
          }
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to start instance.' })
        }
        return { success: true }
      } catch (error: unknown) {
        handleHostError(error)
      }
    }),

  stop: protectedProcedure
    .input(
      z.object({
        name: ContainerNameSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await ctx.host.instance.stop(ctx.user.id, input.name)
        if (!result.success) {
          if (result.reason === 'INVALID_STATE_TRANSITION') {
            throw new TRPCError({ code: 'CONFLICT', message: 'Instance is not in a stoppable state (must be online or starting).' })
          }
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to stop instance.' })
        }
        return { success: true }
      } catch (error: unknown) {
        handleHostError(error)
      }
    }),

  delete: protectedProcedure
    .input(
      z.object({
        name: ContainerNameSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await ctx.host.instance.delete(ctx.user.id, input.name)
        return { success: true }
      } catch (error: unknown) {
        handleHostError(error)
      }
    }),
})
