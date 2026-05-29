import type { EventEmitter } from 'node:events'
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
  host: QilnEngineController
  dispatcher: EventEmitter
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
    host: opts.host,
    dispatcher: opts.dispatcher,
  }
}

interface ContextDeps {
  db?: Database
  host?: QilnEngineController
  dispatcher?: EventEmitter
}

async function createContext(opts: CreateFastifyContextOptions, deps?: ContextDeps) {
  const db = (deps?.db || opts.req.server?.db) as Database
  const host = (deps?.host || opts.req.server?.host) as QilnEngineController
  const dispatcher = (deps?.dispatcher || opts.req.server?.dispatcher) as EventEmitter
  if (!db) {
    throw new Error('Database instance missing in tRPC context. Ensure it is injected or available on req.server.')
  }
  if (!host) {
    throw new Error('QilnEngine services missing in tRPC context.')
  }
  if (!dispatcher) {
    throw new Error('Dispatcher instance missing in tRPC context.')
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
    host,
    dispatcher,
  })
}

export { createContext }
export type Context = Awaited<ReturnType<typeof createContextInner>>
