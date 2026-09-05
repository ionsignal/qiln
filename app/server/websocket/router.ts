import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'

type Target = () => Server | undefined

/**
 * Partitions WebSocket upgrades before tRPC or Vite can observe the socket.
 *
 * The attachment servers never listen directly. Fastify remains the only public
 * HTTP server.
 */
export class UpgradeRouter {
  public readonly trpc = createServer()

  private hmrTarget: Target | undefined
  private open = true

  constructor(
    private readonly server: Server,
    private readonly development: boolean,
  ) {
    this.server.on('upgrade', this.route)
  }

  public setHmr(target: Target): void {
    if (this.development && this.open) {
      this.hmrTarget = target
    }
  }

  public stop(): void {
    if (!this.open) {
      return
    }
    this.open = false
    this.hmrTarget = undefined
    this.server.off('upgrade', this.route)
  }

  private readonly route = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (!this.open || socket.destroyed || !socket.writable) {
      socket.destroy()
      return
    }
    const path = this.path(request)
    let target: Server | undefined
    if (path === '/trpc') {
      target = this.trpc
    } else if (path === '/hmr' && this.development) {
      const protocol = request.headers['sec-websocket-protocol']
      if (protocol === 'vite-hmr' || protocol === 'vite-ping') {
        target = this.hmrTarget?.()
      }
    }
    // Each attachment server is exclusively owned by one integration.
    if (!target || target.listenerCount('upgrade') !== 1) {
      socket.destroy()
      return
    }
    try {
      target.emit('upgrade', request, socket, head)
    } catch {
      socket.destroy()
    }
  }

  private path(request: IncomingMessage): string | undefined {
    const url = request.url
    if (
      request.method !== 'GET' ||
      request.headers.upgrade?.toLowerCase() !== 'websocket' ||
      !url ||
      !url.startsWith('/') ||
      url.startsWith('//')
    ) {
      return undefined
    }
    const queryIndex = url.indexOf('?')
    return queryIndex === -1 ? url : url.slice(0, queryIndex)
  }
}
