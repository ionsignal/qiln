import { logger } from '@server/utils/logger'
import { createFastifyServer } from '@server/start'
import { loadEnvironmentConfig } from '@server/env'
import type { Server, EnvironmentConfig } from '@/types/config'

const shutdownTimeoutMs = 20_000

let server: Server | undefined
let config: EnvironmentConfig
let shutdownPromise: Promise<void> | undefined

function shutdown(exitCode = 0): Promise<void> {
  if (exitCode !== 0) {
    process.exitCode = exitCode
  }
  // Development wrappers may forward signals already delivered by the terminal.
  // Repeated signals must reuse cleanup rather than interrupt it.
  shutdownPromise ??= close()
  return shutdownPromise
}

async function close(): Promise<void> {
  logger.info('[Web] Application shutdown started')
  const timeout = setTimeout(() => {
    logger.error({ timeoutMs: shutdownTimeoutMs }, '[Web] Application shutdown timed out')
    process.exit(1)
  }, shutdownTimeoutMs)
  try {
    await server?.stop()
    logger.info('[Web] Application shutdown completed')
  } catch (error: unknown) {
    process.exitCode = 1
    logger.error({ err: error }, '[Web] Application shutdown failed')
  } finally {
    clearTimeout(timeout)
  }
  process.exit(process.exitCode ?? 0)
}

async function initialize(): Promise<void> {
  config = await loadEnvironmentConfig()
  server = await createFastifyServer(config)
  await server.start()
}

process.on('SIGINT', () => {
  void shutdown()
})

process.on('SIGTERM', () => {
  void shutdown()
})

process.on('uncaughtException', (error: Error) => {
  logger.error({ err: error }, '[Web] Uncaught exception')
  void shutdown(1)
})

process.on('unhandledRejection', (error: unknown) => {
  logger.error({ err: error }, '[Web] Unhandled rejection')
  void shutdown(1)
})

void initialize().catch((error: unknown) => {
  logger.error({ err: error }, '[Web] Application startup failed')
  void shutdown(1)
})

export { config }
