import { router, createCallerFactory, mergeRouters } from '@server/trpc/procedures'
import { agentRouter } from '@server/trpc/routers/agent'
import { apiRouter } from '@server/trpc/routers/api'
import { authRouter } from '@server/trpc/routers/auth'
import { userRouter } from '@server/trpc/routers/user'
import { discordRouter } from '@server/trpc/routers/discord'
import { subscriptionRouter } from '@server/trpc/routers/subscription'
import { engineRouter } from '@qiln/engine/server'

// We merge the Host routers with the Library router.
// The Context types must align for this to work.
export const appRouter = mergeRouters(
  router({
    api: apiRouter,
    agent: agentRouter,
    auth: authRouter,
    user: userRouter,
    discord: discordRouter,
    stream: subscriptionRouter,
    engine: engineRouter,
  }),
)

export type AppRouter = typeof appRouter
export const createCaller = createCallerFactory(appRouter)
export type TRPCCaller = ReturnType<typeof createCaller>
