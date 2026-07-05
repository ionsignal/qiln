import superjson from 'superjson'
import { initTRPC, TRPCError } from '@trpc/server'
import type { EngineContext } from '../types'

/**
 * Initialize tRPC with the Library's specific context requirement.
 */
export const t = initTRPC.context<EngineContext>().create({
  transformer: superjson,
})

/**
 * Local middleware to enforce authentication within the library's scope.
 */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' })
  }
  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  })
})

export const router = t.router
export const publicProcedure = t.procedure
