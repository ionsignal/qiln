import { createServer } from 'node:http'
import { createDevMiddleware } from 'vike/server'
import type { Server } from 'node:http'
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite'
// import type { UpgradeRouter } from './router'

type DevMiddleware = Awaited<ReturnType<typeof createDevMiddleware>>['devMiddleware']
type ViteSocket = ViteDevServer['ws']

function getSocketOptions(config: ResolvedConfig) {
  const options = config.server.ws
  if (!options || typeof options !== 'object') {
    throw new Error('The Host development transport requires Vite WebSockets.')
  }
  return options
}

/**
 * Gives each Vite server generation a private, non-listening attachment server.
 *
 * Vite retains its public ViteDevServer object during restart while replacing
 * its `ws` property. Looking up the target by the current `ws` object therefore
 * selects the active attachment server without exposing Vite internals.
 */
export class ViteTransport {
  private readonly targets = new WeakMap<ViteSocket, Server>()
  private readonly hostname: string
  private readonly clientPort: number
  private server: ViteDevServer | null = null

  constructor(
    // private readonly upgrades: UpgradeRouter,
    publicOrigin: string,
  ) {
    const origin = new URL(publicOrigin)
    this.hostname = origin.hostname
    this.clientPort = origin.port ? Number(origin.port) : origin.protocol === 'https:' ? 443 : 80
  }

  public async open(root: string): Promise<DevMiddleware> {
    const development = await createDevMiddleware({
      root,
      viteConfig: {
        optimizeDeps: {
          force: false,
        },
        plugins: [this.plugin()],
        server: {
          allowedHosts: [this.hostname],
          ws: {
            clientPort: this.clientPort,
          },
        },
      },
    })
    this.server = development.viteServer
    return development.devMiddleware
  }

  public target(): Server | undefined {
    return this.server ? this.targets.get(this.server.ws) : undefined
  }

  public async close(): Promise<void> {
    const server = this.server
    this.server = null
    await server?.close()
  }

  private plugin(): Plugin {
    let attachment: Server | undefined
    return {
      name: 'qiln:upgrade-target',
      enforce: 'post',
      config: () => {
        attachment = createServer()
        return {
          server: {
            ws: {
              server: attachment,
            },
          },
        }
      },
      configResolved: config => {
        const socket = getSocketOptions(config)
        if (!attachment || socket.server !== attachment) {
          throw new Error('Vite WebSocket attachment was overridden outside the Host transport integration.')
        }
        if (config.base !== '/' || socket.path !== '/hmr') {
          throw new Error('The Host development transport requires Vite base "/" and WebSocket path "/hmr".')
        }
        if (socket.clientPort !== this.clientPort) {
          throw new Error('Vite WebSocket clientPort must match the development public origin.')
        }
        if (config.server.allowedHosts === true || !config.server.allowedHosts.includes(this.hostname)) {
          throw new Error('Vite must use an explicit allowlist containing the development public hostname.')
        }
      },
      configureServer: server => {
        const socket = getSocketOptions(server.config)
        if (!attachment || socket.server !== attachment) {
          throw new Error('Vite server has no matching Host-owned WebSocket attachment.')
        }
        this.targets.set(server.ws, attachment)
      },
    }
  }
}
