import path from 'node:path'
import fastify from 'fastify'
import autoload from '@fastify/autoload'
import serve from '@fastify/static'
import superjson from 'superjson'
import { renderPage, createDevMiddleware } from 'vike/server'
import { createTRPCClient, unstable_localLink } from '@trpc/client'
import { appRouter } from '@server/trpc'
import { createContextInner } from '@server/trpc/context'
import { logger } from '@server/utils/logger'
import type { FastifyRequest, FastifyReply } from 'fastify'
import type { EnvironmentConfig } from '@/types'

async function createFastifyServer(config: EnvironmentConfig) {
  // Initialize Fastify Server
  const server = fastify({
    loggerInstance: logger,
    disableRequestLogging: true,
  })
  // Decorate Server Instance
  server.decorate('config', config)
  // Register Plugins & Routes
  const distPath = path.resolve(config.path, 'dist/server')
  await server.register(autoload, {
    forceESM: true,
    dir: path.join(distPath, 'plugins'),
    options: {},
  })
  await server.register(autoload, {
    forceESM: true,
    dir: path.join(distPath, 'routes'),
    options: {},
  })
  // Configure Static Assets / Dev Middleware
  if (!server.config.dev) {
    await server.register(serve, {
      prefix: '/',
      wildcard: false,
      decorateReply: false,
      root: path.join(config.path, 'dist/client'),
    })
  } else {
    const vike = await createDevMiddleware({
      root: config.path,
      viteConfig: {
        optimizeDeps: { force: false },
      },
    })
    await server.use(vike.devMiddleware)
  }
  // Vike (SSR) Handler
  server.get('*', async (request: FastifyRequest, reply: FastifyReply) => {
    const db = server.db
    const engine = server.engine
    const user = request.session?.user ?? null
    const trpc = createTRPCClient<typeof appRouter>({
      links: [
        unstable_localLink({
          router: appRouter,
          createContext: async () =>
            createContextInner({
              req: request,
              res: reply,
              db,
              engine,
              user,
            }),
          transformer: superjson,
        }),
      ],
    })
    const pageContext = await renderPage({
      trpc,
      user,
      redirectTo: null,
      urlOriginal: request.raw.url ?? '/',
    })
    if (!pageContext.httpResponse) {
      return reply.callNotFound()
    }
    const { statusCode, headers, getReadableNodeStream } = pageContext.httpResponse
    headers.forEach(([name, value]) => reply.header(name, value))
    reply.status(statusCode)
    const stream = await getReadableNodeStream()
    return reply.send(stream)
  })

  async function start() {
    const port = server.config.port
    const host = server.config.listen ? '0.0.0.0' : '127.0.0.1'
    await server.listen({ port, host })
  }

  async function stop() {
    await server.close()
  }

  return { server, start, stop }
}

export { createFastifyServer }
