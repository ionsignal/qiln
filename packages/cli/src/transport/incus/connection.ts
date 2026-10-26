import { connect } from 'node:net'
import type { Duplex } from 'node:stream'

/**
 * Where an Incus request travels. The client owns each request and its stream;
 * the connection only opens one fresh stream per request.
 */
export interface IncusConnection {
  readonly endpoint: string
  open(signal: AbortSignal): Promise<Duplex>
}

export function localConnection(socketPath: string): IncusConnection {
  return {
    endpoint: socketPath,
    open: signal =>
      new Promise<Duplex>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason)
          return
        }
        const socket = connect({ path: socketPath })
        const onAbort = () => {
          socket.destroy()
          reject(signal.reason)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        socket.once('error', reject)
        socket.once('connect', () => {
          signal.removeEventListener('abort', onAbort)
          socket.off('error', reject)
          resolve(socket)
        })
      }),
  }
}
