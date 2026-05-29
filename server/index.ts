import grace from 'close-with-grace'
import { loadConfig } from 'c12'
import { logger } from '@server/utils/logger'
import { createFastifyServer } from '@server/start'
import type { Server, EnvironmentConfig } from '@/types/config'

const graceOptions = { delay: 500 }
const closeListeners = grace(graceOptions, async (callback: any) => {
  if (callback.err) {
    logger.error(callback.err)
  }
  // Check if server has been initialized before attempting to close
  if (fastifyServer?.server) {
    await fastifyServer.server.close()
  }
})

let fastifyServer: Server
let config: EnvironmentConfig
let options = { configFile: 'dist/server/config', dotenv: true }
loadConfig<EnvironmentConfig>(options).then(async resolved => {
  if (!resolved.config) {
    throw Error('application environment configuration missing')
  }
  config = resolved.config

  // create and start fastify server
  fastifyServer = await createFastifyServer(config)
  fastifyServer.start()
  fastifyServer.server.addHook('onClose', (_, done) => {
    logger.warn('shutting down')
    closeListeners.uninstall()
    done()
  })
})

export { config }
