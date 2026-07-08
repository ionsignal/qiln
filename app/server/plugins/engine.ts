import fp from 'fastify-plugin'
import { enginePlugin } from '@qiln/engine/server'
import type { CapsuleHostDbContract } from '@qiln/core/server'

export default fp(
  async fastify => {
    const db = fastify.db as unknown as CapsuleHostDbContract
    await fastify.register(enginePlugin, {
      db,
      config: fastify.config,
    })
    fastify.log.info('[Engine] QilnEngine module registered.')
  },
  {
    name: 'engine',
    dependencies: ['db', 'worker'],
  },
)
