import fp from 'fastify-plugin'
import { enginePlugin } from '@qiln/engine/server'
import type { CapsuleBranchHostDbContract } from '@qiln/core/server'

export default fp(
  async fastify => {
    const { db, config } = fastify
    await fastify.register(enginePlugin, {
      db: db as unknown as CapsuleBranchHostDbContract,
      config: config,
    })
    fastify.log.info('[Engine] QilnEngine module registered.')
  },
  {
    name: 'engine',
    dependencies: ['db', 'worker'],
  },
)
