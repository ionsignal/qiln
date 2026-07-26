import fp from 'fastify-plugin'
import { enginePlugin } from '@qiln/engine/server'

export default fp(
  async fastify => {
    await fastify.register(enginePlugin, {
      persistence: fastify.persistence,
      config: fastify.config,
    })
    fastify.log.info('[Engine] QilnEngine module registered.')
  },
  {
    name: 'engine',
    dependencies: ['db', 'worker'],
  },
)
