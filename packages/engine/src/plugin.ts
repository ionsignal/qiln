import fp from 'fastify-plugin'
import { QilnEngineController } from './controller'
import type { HostPluginOptions } from './types'

export const qilnEnginePlugin = fp(
  async (fastify, options: HostPluginOptions) => {
    fastify.log.debug('[QilnEngine] Initializing infrastructure module...')
    const controller = new QilnEngineController(options.db, options.config)
    fastify.decorate('host', controller)
    try {
      await controller.start()
      fastify.log.info('[QilnEngine] Transport connected.')
      try {
        await controller.instance.reconcile()
        fastify.log.info('[QilnEngine] Database reconciled with Incus state.')
      } catch (reconErr) {
        fastify.log.warn('[QilnEngine] Incus unreachable during boot. Skipping reconciliation.')
      }
      fastify.addHook('onClose', async () => {
        fastify.log.info('[QilnEngine] Shutting down transport...')
        try {
          await controller.stop()
        } catch (shutdownErr) {
          fastify.log.error({ err: shutdownErr }, '[QilnEngine] Error during transport shutdown')
        }
      })
    } catch (err) {
      fastify.log.error({ err }, '[QilnEngine] Failed to initialize transport.')
      throw err
    }
  },
  {
    name: '@qiln/engine',
  },
)
