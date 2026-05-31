import fp from 'fastify-plugin'
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import { appRouter } from '@server/trpc'
import { createContext } from '@server/trpc/context'
import type { AppRouter } from '@server/trpc'
import type { FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify'

export default fp(
  async fastify => {
    fastify.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      useWSS: true,
      trpcOptions: {
        router: appRouter,
        createContext: opts =>
          createContext(opts, {
            db: fastify.db,
            host: fastify.host,
            dispatcher: fastify.dispatcher,
          }),
        onError: ({ path, error, type }) => {
          if (error.code === 'INTERNAL_SERVER_ERROR') {
            fastify.log.error(
              {
                err: error,
                path,
                type,
                code: error.code,
              },
              `[tRPC] Critical error in ${type} operation on path '${path}'`,
            )
          } else {
            // Single-line warning for expected business logic violations
            fastify.log.warn(`[tRPC] ${error.code} in ${type} on '${path}': ${error.message}`)
          }
        },
      },
    } as FastifyTRPCPluginOptions<AppRouter>)
  },
  {
    name: 'trpc',
    dependencies: ['socket', 'db', 'middleware', 'host', 'session', 'bridge'],
  },
)
