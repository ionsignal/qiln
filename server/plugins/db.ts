import fp from 'fastify-plugin'
import { createDataLayer } from '@server/db'

export default fp(
  async fastify => {
    fastify.log.info('[Db] Initializing Data Layer (Postgres)...')
    const connectionString = fastify.config.database.url
    const { db, close } = createDataLayer(connectionString)
    fastify.decorate('db', db)
    fastify.addHook('onClose', async () => {
      fastify.log.info('[Db] Shutting down Data Layer...')
      await close()
    })
  },
  {
    name: 'db',
    dependencies: [], // No dependencies, this is a root infrastructure plugin
  },
)
