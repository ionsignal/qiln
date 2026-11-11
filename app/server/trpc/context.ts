import type { FastifyRequest } from 'fastify'
import type { IncomingMessage } from 'http'
import type { Database } from '@server/db'
import type { QilnEngineController } from '@qiln/engine/server'
import type { AuthenticatedUser } from '@/types/entities'
import type { SshControlClient } from '@server/ssh'
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'

const loopbackPeer = /^(127\.|::1$|::ffff:127\.)/

type ContextDependencies = Pick<InnerContextOptions, 'db' | 'engine' | 'ssh'>

export interface InnerContextOptions {
  req: FastifyRequest | IncomingMessage
  res: unknown
  db: Database
  engine: QilnEngineController
  ssh: SshControlClient
  user: AuthenticatedUser | null
}

/**
 * The forwarded header is honored only from a loopback peer. Web listens on
 * loopback alone, so that peer is Caddy, which overwrites client-supplied
 * values. HTTP, SSR, and WebSocket requests all expose these two members.
 */
function clientAddressOf(req: Pick<IncomingMessage, 'socket' | 'headers'>): string {
  const peer = req.socket.remoteAddress ?? 'unknown'
  if (!loopbackPeer.test(peer)) {
    return peer
  }
  const forwarded = req.headers['x-forwarded-for']
  const chain = Array.isArray(forwarded) ? forwarded.join(',') : forwarded
  return chain?.split(',').at(-1)?.trim() || peer
}

export async function createContextInner(opts: InnerContextOptions) {
  return {
    db: opts.db,
    user: opts.user,
    engine: opts.engine,
    ssh: opts.ssh,
    clientAddress: clientAddressOf(opts.req),
    fastify: {
      req: opts.req as FastifyRequest,
      res: opts.res,
    },
  }
}

async function createContext(opts: CreateFastifyContextOptions, deps: ContextDependencies) {
  return createContextInner({
    req: opts.req,
    res: opts.res,
    user: opts.req.session?.user ?? null,
    ...deps,
  })
}

export { createContext }
export type Context = Awaited<ReturnType<typeof createContextInner>>
