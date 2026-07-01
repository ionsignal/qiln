import fp from 'fastify-plugin'
import { QilnEngineController } from './controller'
import type { HostPluginOptions } from './types'

export const qilnEnginePlugin = fp(
  async (fastify, options: HostPluginOptions) => {
    fastify.log.debug('[QilnEngine] Initializing capsule engine module...')
    const controller = new QilnEngineController(options.db, options.config)
    fastify.decorate('host', controller)
    try {
      await controller.start()
      fastify.log.info('[QilnEngine] Capsule Channel connected.')
      fastify.addHook('onClose', async () => {
        fastify.log.info('[QilnEngine] Shutting down Capsule Channel...')
        try {
          await controller.stop()
        } catch (shutdownErr: unknown) {
          fastify.log.error({ err: shutdownErr }, '[QilnEngine] Error during Capsule Channel shutdown')
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
