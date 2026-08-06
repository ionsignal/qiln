import fp from 'fastify-plugin'
import { CapsuleNatsChannel } from '@qiln/core/server'

export default fp(
  async fastify => {
    const channel = new CapsuleNatsChannel(fastify.config.nats, {
      loggerPrefix: '[Agent CapsuleChannel]',
    })
    fastify.decorate('agentChannel', channel)
    await channel.start()
    fastify.addHook('onClose', async () => {
      await channel.shutdown()
    })
  },
  {
    name: 'agent',
    dependencies: ['db'],
  },
)
