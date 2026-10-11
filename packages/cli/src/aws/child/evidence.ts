import { InstallerError, type InstallerErrorCode } from '../../diagnostic/error'

/**
 * Child side of the evidence exchange. The message crosses IPC once, and the
 * child may continue only after the parent acknowledges durable retention.
 */
export async function sendEvidence(
  evidence: object,
  acknowledged: (message: unknown) => boolean,
  signal: AbortSignal,
  failure: InstallerErrorCode,
): Promise<void> {
  if (!process.send || !process.connected) {
    throw new InstallerError({
      code: failure,
    })
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: InstallerError) => {
      if (settled) {
        return
      }
      settled = true
      process.off('message', onMessage)
      process.off('disconnect', onDisconnect)
      signal.removeEventListener('abort', onAbort)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const unavailable = () =>
      finish(
        new InstallerError({
          code: failure,
        }),
      )
    const onMessage = (message: unknown) => {
      if (acknowledged(message)) {
        finish()
      } else {
        unavailable()
      }
    }
    const onDisconnect = () => unavailable()
    const onAbort = () => unavailable()
    process.once('message', onMessage)
    process.once('disconnect', onDisconnect)
    signal.addEventListener('abort', onAbort, {
      once: true,
    })
    if (signal.aborted || !process.send || !process.connected) {
      unavailable()
      return
    }
    process.send(evidence, error => {
      if (error) {
        unavailable()
      }
    })
  })
}
