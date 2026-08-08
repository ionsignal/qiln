import fp from 'fastify-plugin'
import { QilnEngineController } from './controller'
import type { EnginePluginOptions } from './types'

export const enginePlugin = fp(
  async (fastify, options: EnginePluginOptions) => {
    fastify.log.debug('[QilnEngine] Initializing capsule engine module...')
    const controller = new QilnEngineController(options.persistence, options.config)
    fastify.decorate('engine', controller)
    try {
      await controller.start()
      fastify.log.info('[QilnEngine] Capsule Channel connected.')
      fastify.addHook('onClose', async () => {
        fastify.log.info('[QilnEngine] Shutting down Capsule Channel...')
        try {
          await controller.stop()
        } catch (err: unknown) {
          fastify.log.error({ err }, '[QilnEngine] Error during Capsule Channel shutdown')
        }
      })
    } catch (err: unknown) {
      fastify.log.error({ err }, '[QilnEngine] Failed to initialize capsule engine module.')
      throw err
    }
  },
  {
    name: '@qiln/engine',
  },
)
