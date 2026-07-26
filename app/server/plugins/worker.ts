import fp from 'fastify-plugin'
import { QilnWorkerRuntime } from '@qiln/worker/server'

export default fp(
  async fastify => {
    fastify.decorate('worker', null)
    if (!fastify.config.worker.embedded) {
      fastify.log.info(
        '[Worker] Embedded worker disabled. Expecting external qiln-worker runtime for privileged mutations.',
      )
      return
    }
    fastify.log.warn(
      '[Worker] Embedded worker enabled. This is a dev/proof-of-life mode only and does not provide a production privilege boundary.',
    )
    const worker = new QilnWorkerRuntime({
      persistence: fastify.persistence,
      config: fastify.config,
    })
    await worker.start()
    fastify.worker = worker
    fastify.addHook('onClose', async () => {
      if (fastify.worker !== worker) {
        return
      }
      fastify.log.info('[Worker] Stopping embedded worker runtime...')
      try {
        await worker.stop()
      } catch (error: unknown) {
        fastify.log.error({ err: error }, '[Worker] Error while stopping embedded worker runtime')
      } finally {
        fastify.worker = null
      }
    })
  },
  {
    name: 'worker',
    dependencies: ['db'],
  },
)
