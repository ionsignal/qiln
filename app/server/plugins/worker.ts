import fp from 'fastify-plugin'
import { QilnWorkerRuntime, type HostDbContract as WorkerHostDbContract } from '@qiln/worker/server'

export default fp(
  async fastify => {
    fastify.decorate('worker', null)
    if (!fastify.config.worker.embedded) {
      fastify.log.info('[Worker] Embedded worker disabled. Expecting external qiln-worker runtime for privileged mutations.')
      return
    }
    fastify.log.warn(
      '[Worker] Embedded worker enabled. This is a dev/proof-of-life mode only and does not provide a production privilege boundary.',
    )
    const runtime = new QilnWorkerRuntime({
      db: fastify.db as unknown as WorkerHostDbContract,
      config: fastify.config,
      reconcileOnStart: fastify.config.worker.reconcileOnStart,
    })
    await runtime.start()
    fastify.worker = runtime
    fastify.addHook('onClose', async () => {
      if (fastify.worker !== runtime) return
      fastify.log.info('[Worker] Stopping embedded worker runtime...')
      try {
        await runtime.stop()
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
