import fp from 'fastify-plugin'
import { EventEmitter } from 'node:events'

export default fp(
  async fastify => {
    fastify.log.info('[Bridge] Initializing Event Bridge & Local Dispatcher...')
    const dispatcher = new EventEmitter()
    dispatcher.setMaxListeners(0)
    fastify.decorate('dispatcher', dispatcher)
    // Concurrent IIFE for qiln-engine stream
    void (async () => {
      try {
        for await (const envelope of fastify.host.broker.subscribe(() => true)) {
          const { routing, ...cleanEnvelope } = envelope
          if (routing.type === 'broadcast') {
            fastify.dispatcher.emit('event:broadcast', cleanEnvelope)
          } else if (routing.type === 'unicast') {
            fastify.dispatcher.emit(`event:user:${routing.userId}`, cleanEnvelope)
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name !== 'AbortError') {
          fastify.log.error({ err: error }, '[Bridge] Unexpected error in qiln-engine event stream')
        }
      }
    })()
  },
  {
    name: 'bridge',
    dependencies: ['host'],
  },
)
