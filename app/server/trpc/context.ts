import type { Database } from '@server/db'
import type { QilnEngineController } from '@qiln/engine/server'
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'
import type { IncomingMessage } from 'http'
import type { FastifyRequest, FastifyReply } from 'fastify'
import type { AuthenticatedUser } from '@/types/entities'

export interface InnerContextOptions {
  req: FastifyRequest | IncomingMessage
  res: FastifyReply | unknown
  db: Database
  engine: QilnEngineController
  user: AuthenticatedUser | null
}

export async function createContextInner(opts: InnerContextOptions) {
  return {
    fastify: {
      req: opts.req as FastifyRequest,
      res: opts.res as FastifyReply | unknown,
    },
    db: opts.db,
    user: opts.user,
    engine: opts.engine,
  }
}

interface ContextDeps {
  db?: Database
  engine?: QilnEngineController
}

async function createContext(opts: CreateFastifyContextOptions, deps?: ContextDeps) {
  const db = (deps?.db || opts.req.server?.db) as Database
  const engine = (deps?.engine || opts.req.server?.engine) as QilnEngineController
  if (!db) {
    throw new Error('Database instance missing in tRPC context. Ensure it is injected or available on req.server.')
  }
  if (!engine) {
    throw new Error('QilnEngine services missing in tRPC context.')
  }
  let user = opts.req.session?.user ?? null
  if (!user) {
    const rawReq = opts.req as unknown as IncomingMessage
    if (rawReq.session?.user) {
      user = rawReq.session.user
    }
  }
  return createContextInner({
    req: opts.req,
    res: opts.res,
    db,
    user,
    engine,
  })
}

export { createContext }
export type Context = Awaited<ReturnType<typeof createContextInner>>
