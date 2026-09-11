import fp from 'fastify-plugin'
import { createDatabase } from '@server/db'

export default fp(
  async fastify => {
    fastify.log.info('[Db] Initializing database (Postgres)...')
    const connectionString = fastify.config.database.url
    const { db, persistence, close } = createDatabase(connectionString, {
      queries: fastify.config.observability.queries,
    })
    fastify.decorate('db', db)
    fastify.decorate('persistence', persistence)
    fastify.addHook('onClose', async () => {
      fastify.log.info('[Db] Closing database connection...')
      await close()
    })
  },
  {
    name: 'db',
    dependencies: [], // No dependencies, this is a root infrastructure plugin
  },
)
