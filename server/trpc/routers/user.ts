import { z } from 'zod'
import { publicProcedure, router } from '@server/trpc/procedures'

/**
 * Handles user profile operations
 */
export const userRouter = router({
  get: publicProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const user = await ctx.db.query.users.findFirst({
      where: {
        id: input.id,
      },
      columns: {
        id: true,
        username: true,
        avatar: true,
        createdAt: true,
      },
    })
    return user || null
  }),

  getBatch: publicProcedure.input(z.object({ ids: z.array(z.uuid()) })).query(async ({ ctx, input }) => {
    if (input.ids.length === 0) return []
    const results = await ctx.db.query.users.findMany({
      where: {
        id: {
          in: input.ids,
        },
      },
      columns: {
        id: true,
        username: true,
        avatar: true,
      },
    })
    return results
  }),
})
