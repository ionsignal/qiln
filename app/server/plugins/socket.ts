import fp from 'fastify-plugin'
import fastifyWebsocket from '@fastify/websocket'

export default fp(
  async fastify => {
    // Register the WebSocket plugin for tRPC subscriptions
    await fastify.register(fastifyWebsocket)
    fastify.log.info('[IonBridge] WebSocket transport initialized for tRPC subscriptions')
  },
  {
    name: 'socket',
    dependencies: [],
  },
)
