import grace from 'close-with-grace'
import { logger } from '@server/utils/logger'
import { createFastifyServer } from '@server/start'
import { loadEnvironmentConfig } from '@server/env'
import type { Server, EnvironmentConfig } from '@/types/config'

const graceOptions = { delay: 500 }
let fastifyServer: Server | undefined
let config: EnvironmentConfig

const closeListeners = grace(graceOptions, async ({ err }) => {
  if (err) {
    logger.error(err)
  }
  await fastifyServer?.stop()
})

async function initialize(): Promise<void> {
  config = await loadEnvironmentConfig()
  fastifyServer = await createFastifyServer(config)

  fastifyServer.server.addHook('onClose', (_, done) => {
    logger.warn('shutting down')
    closeListeners.uninstall()
    done()
  })

  await fastifyServer.start()
}

void initialize().catch((error: unknown) => {
  logger.error({ err: error }, '[Web] Application startup failed')
  process.exitCode = 1
  closeListeners.uninstall()
})

export { config }
