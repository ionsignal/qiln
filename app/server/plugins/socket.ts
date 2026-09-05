import fp from 'fastify-plugin'
import fastifyWebsocket from '@fastify/websocket'

export default fp(
  async fastify => {
    const attachment = fastify.upgrades.trpc
    await fastify.register(fastifyWebsocket, {
      options: {
        server: attachment,
      },
      preClose: async () => {
        const websocketServer = fastify.websocketServer
        // The upstream default removes its listener from fastify.server even
        // when a separate attachment server was configured.
        attachment.removeAllListeners('upgrade')
        for (const client of websocketServer.clients) {
          client.terminate()
        }
        await new Promise<void>((resolve, reject) => {
          websocketServer.close(error => {
            if (error) {
              reject(error)
            } else {
              resolve()
            }
          })
        })
      },
    })
    fastify.log.info('[WebSocket] tRPC transport initialized on /trpc')
  },
  {
    name: 'socket',
    dependencies: [],
  },
)
