import { SshError } from './failure'
import { endpointFacts, withSession, type SshSession } from './session'
import { execLimitsSchema, parseLimits, type ExecLimits, type SshOptions } from './options'

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * A command is a fixed string without stdin. A nonzero exit code is a result
 * for the caller to judge. Only a missing exit status, the deadline, the output
 * limit, cancellation, or a lost connection is a failure. Limits default to the
 * connection options and may be overridden per command.
 *
 * Any failure invalidates the connection, so later calls fail as a lost
 * connection.
 */
export interface Remote {
  exec(command: string, limits?: Partial<ExecLimits>): Promise<CommandResult>
}

function createRemote({ client, options, signal, link }: SshSession): Remote {
  return {
    exec: async (command, overrides = {}) => {
      const limits = parseLimits(execLimitsSchema, {
        timeoutMs: options.commandTimeoutMs,
        maxOutputBytes: options.maxOutputBytes,
        ...overrides,
      })
      return await new Promise<CommandResult>((resolve, reject) => {
        if (signal.aborted) {
          reject(new SshError({ kind: 'cancelled' }))
          return
        }
        if (link.lost) {
          reject(new SshError({ kind: 'connection', facts: endpointFacts(options) }))
          return
        }
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        let received = 0
        let settled = false
        const timer = setTimeout(() => fail('timeout'), limits.timeoutMs)
        const fail = (reason: string) => {
          if (settled) {
            return
          }
          settled = true
          clearTimeout(timer)
          unwatch()
          link.lose()
          client.destroy()
          reject(
            new SshError({
              kind: signal.aborted ? 'cancelled' : 'command',
              remoteStarted: true,
              facts: [['Command failure', reason]],
            }),
          )
        }
        const unwatch = link.watch(() => fail('connection lost'))
        const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
          if (settled) {
            return
          }
          received += chunk.byteLength
          if (received > limits.maxOutputBytes) {
            fail('output limit exceeded')
            return
          }
          chunks.push(chunk)
        }
        try {
          client.exec(command, (error, stream) => {
            if (settled) {
              if (!error) {
                stream.destroy()
              }
              return
            }
            if (error) {
              fail('request not accepted')
              return
            }
            stream.on('error', () => fail('channel error'))
            stream.stderr.on('error', () => fail('channel error'))
            stream.end()
            stream.on('data', collect(stdout))
            stream.stderr.on('data', collect(stderr))
            stream.once('close', (code?: unknown) => {
              if (settled) {
                return
              }
              if (link.lost || signal.aborted) {
                fail('connection lost before completion')
                return
              }
              if (typeof code !== 'number') {
                fail('no exit status reported')
                return
              }
              settled = true
              clearTimeout(timer)
              unwatch()
              resolve({
                exitCode: code,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
              })
            })
          })
        } catch {
          fail('request not accepted')
        }
      })
    },
  }
}

/**
 * One pinned connection for the duration of `use`, offering command execution.
 */
export function withSsh<T>(
  input: SshOptions,
  privateKey: Buffer,
  signal: AbortSignal,
  use: (remote: Remote) => Promise<T>,
): Promise<T> {
  return withSession(input, privateKey, signal, session => use(createRemote(session)))
}
