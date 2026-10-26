import { SshError } from './failure'
import { endpointFacts, withSession, type SshSession } from './session'
import type { Duplex } from 'node:stream'
import type { ClientChannel } from 'ssh2'
import type { IncusConnection } from '../transport/incus/connection'
import type { SshOptions } from './options'

function interrupted({ signal, options }: SshSession): SshError {
  return signal.aborted ? new SshError({ kind: 'cancelled' }) : new SshError({ kind: 'connection', facts: endpointFacts(options) })
}

/**
 * Node's HTTP client treats its connection as a net.Socket and calls methods an
 * SSH channel lacks, so they are supplied as no-ops. Deadlines stay with the
 * request, never the socket.
 */
function asHttpSocket(channel: ClientChannel): Duplex {
  return Object.assign(channel, {
    destroySoon: () => channel.destroy(),
    setNoDelay: () => channel,
    setKeepAlive: () => channel,
    setTimeout: () => channel,
    ref: () => channel,
    unref: () => channel,
  })
}

/**
 * Exposes one Unix socket on the target through a scoped SSH session, opening
 * one channel per request. This deliberately avoids `forwardOut` (TCP),
 * `openssh_forwardInStreamLocal` (a remote listener), and `ssh2.HTTPAgent`
 * (TCP forwarding over its own connection). A denied or unsupported forward is
 * a failure; there is no alternate relay.
 */
export function withSocket<T>(
  input: SshOptions,
  privateKey: Buffer,
  signal: AbortSignal,
  socketPath: string,
  use: (connection: IncusConnection) => Promise<T>,
): Promise<T> {
  return withSession(input, privateKey, signal, session => {
    const { client, link, options } = session
    const connection: IncusConnection = {
      endpoint: `${socketPath} on ${options.username}@${options.host}:${options.port}`,
      open: requestSignal =>
        new Promise<Duplex>((resolve, reject) => {
          if (requestSignal.aborted) {
            reject(requestSignal.reason)
            return
          }
          if (link.lost) {
            reject(interrupted(session))
            return
          }
          const release = () => {
            unwatch()
            requestSignal.removeEventListener('abort', onAbort)
          }
          const onAbort = () => {
            release()
            reject(requestSignal.reason)
          }
          const unwatch = link.watch(() => {
            release()
            reject(interrupted(session))
          })
          requestSignal.addEventListener('abort', onAbort, { once: true })
          const refuse = () => {
            release()
            reject(new SshError({ kind: 'socket', facts: [...endpointFacts(options), ['Socket', socketPath]] }))
          }
          try {
            client.openssh_forwardOutStreamLocal(socketPath, (error, channel) => {
              release()
              if (requestSignal.aborted || link.lost) {
                if (!error) {
                  channel.destroy()
                }
                return
              }
              if (error) {
                refuse()
                return
              }
              resolve(asHttpSocket(channel))
            })
          } catch {
            refuse()
          }
        }),
    }
    return use(connection)
  })
}
