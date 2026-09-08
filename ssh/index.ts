import grace from 'close-with-grace'
import pino from 'pino'
import { loadSshConfig } from './config'
import { startSsh } from './start'
import type { SshService } from './start'

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
})

let service: SshService | undefined
let initialization: Promise<void> | undefined
let stopping = false

const closeListeners = grace({ delay: 35_000 }, async ({ err }) => {
  if (err) {
    logger.error({ err }, '[SSH] Process shutdown requested after an error')
  }
  stopping = true
  await initialization?.catch(() => undefined)
  try {
    await service?.stop()
  } catch (error: unknown) {
    logger.fatal({ err: error }, '[SSH] Shutdown failed. Terminating without normal authority release.')
    process.exit(1)
  }
})

async function initialize(): Promise<void> {
  const config = await loadSshConfig()
  if (stopping) {
    return
  }
  service = await startSsh(config, logger, error => {
    // An authority failure cannot be repaired by replacing the runtime while
    // promises from the previous authority may still execute.
    logger.fatal({ err: error }, '[SSH] Terminating after SSH authority failure.')
    process.exit(1)
  })
}

initialization = initialize()
void initialization.catch((error: unknown) => {
  logger.error({ err: error }, '[SSH] Application startup failed')
  process.exitCode = 1
  closeListeners.uninstall()
})
