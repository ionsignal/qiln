import fp from 'fastify-plugin'
import { CapsuleNatsChannel } from '@qiln/core/server'

export default fp(
  async fastify => {
    const channel = new CapsuleNatsChannel(fastify.config.nats, {
      loggerPrefix: '[QilnHost CapsuleChannel]',
    })
    await channel.start()
    fastify.decorate('channel', channel)
    fastify.addHook('onClose', async () => {
      fastify.log.info('[CapsuleChannel] Shutting down Host Capsule Channel...')
      await channel.shutdown()
    })
    fastify.log.info('[CapsuleChannel] Host Capsule Channel initialized')
  },
  {
    name: 'capsule-channel',
    dependencies: [],
  },
)
