import superjson from 'superjson'
import { initTRPC, TRPCError } from '@trpc/server'
import type { Context } from '@server/trpc/context'

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        // In production, we strip the stack trace to prevent information leakage.
        stack: process.env.NODE_ENV === 'production' ? undefined : shape.data.stack,
      },
    }
  },
})

/**
 * Middleware to check if a user is authenticated. If not, it throws an
 * UNAUTHORIZED error.
 */
const isAuthed = t.middleware(({ next, ctx }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' })
  }
  return next({
    ctx: {
      // Infers the user as non-nullable in protected procedures
      user: ctx.user,
    },
  })
})

export const publicProcedure = t.procedure
export const protectedProcedure = t.procedure.use(isAuthed)
export const router = t.router
export const middleware = t.middleware
export const createCallerFactory = t.createCallerFactory
export const mergeRouters = t.mergeRouters
