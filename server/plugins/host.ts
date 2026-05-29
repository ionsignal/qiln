import fp from 'fastify-plugin'
import { qilnEnginePlugin } from '@qiln/engine/server'
import type { HostDbContract } from '@qiln/engine/server'

export default fp(
  async fastify => {
    const { db, config } = fastify
    await fastify.register(qilnEnginePlugin, {
      db: db as unknown as HostDbContract,
      config: config,
    })
    fastify.log.info('[Host] QilnEngine module registered.')
  },
  {
    name: 'host',
    dependencies: ['db'],
  },
)
