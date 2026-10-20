import { Client } from 'ssh2'
import type { DiagnosticFact } from '../diagnostic/error'
import { SshError } from './failure'
import { fingerprintOf } from './key'
import { parseOptions, type SshOptions } from './options'

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * A command is a fixed string without stdin. A nonzero exit code is a result
 * for the caller to judge. Only a missing exit status, the deadline, the output
 * limit, cancellation, or a lost connection is a failure.
 */
export interface Remote {
  exec(command: string): Promise<CommandResult>
}

interface Handshake {
  observed: string | undefined
}

/**
 * Connection-wide failure latch. It is set before a connection is destroyed,
 * so pending work fails with its own classification instead of being decided
 * by whichever library event happens to arrive first. Once set, it stays set.
 */
class Link {
  public lost = false
  private readonly watchers = new Set<() => void>()

  public lose(): void {
    if (this.lost) {
      return
    }
    this.lost = true
    for (const watcher of [...this.watchers]) {
      watcher()
    }
  }

  public watch(watcher: () => void): () => void {
    this.watchers.add(watcher)
    return () => {
      this.watchers.delete(watcher)
    }
  }
}

function levelOf(error: unknown): unknown {
  return error instanceof Error && 'level' in error ? error.level : undefined
}

function endpointFacts(options: SshOptions): DiagnosticFact[] {
  return [
    ['Endpoint', `${options.host}:${options.port}`],
    ['User', options.username],
  ]
}

function connect(client: Client, options: SshOptions, privateKey: Buffer, handshake: Handshake): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve())
    client.on('error', reject)
    client.once('close', () => reject(new Error('The connection closed before it was ready.')))
    client.connect({
      host: options.host,
      port: options.port,
      username: options.username,
      privateKey,
      algorithms: {
        serverHostKey: ['ssh-ed25519'],
      },
      hostVerifier: (key: Buffer | string) => {
        if (typeof key === 'string') {
          return false
        }
        handshake.observed = fingerprintOf(key)
        return handshake.observed === options.fingerprint
      },
      authHandler: ['publickey'],
      readyTimeout: options.connectTimeoutMs,
    })
  })
}

function connectionFailure(error: unknown, options: SshOptions, handshake: Handshake, signal: AbortSignal): SshError {
  if (signal.aborted) {
    return new SshError({ kind: 'cancelled' })
  }
  if (handshake.observed !== undefined && handshake.observed !== options.fingerprint) {
    return new SshError({
      kind: 'host-key',
      facts: [
        ['Pinned fingerprint', `SHA256:${options.fingerprint}`],
        ['Observed fingerprint', `SHA256:${handshake.observed}`],
      ],
    })
  }
  return new SshError({
    kind: levelOf(error) === 'client-authentication' ? 'authentication' : 'connection',
    facts: endpointFacts(options),
  })
}

function createRemote(client: Client, options: SshOptions, signal: AbortSignal, link: Link): Remote {
  return {
    exec: command =>
      new Promise<CommandResult>((resolve, reject) => {
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
        const timer = setTimeout(() => fail('timeout'), options.commandTimeoutMs)
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
              commandStarted: true,
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
          if (received > options.maxOutputBytes) {
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
      }),
  }
}

/**
 * One pinned connection for the duration of `use`. The server must present an
 * Ed25519 host key whose fingerprint equals the pin, and only public-key
 * authentication is attempted. There are no retries or reconnects, and the
 * connection is always destroyed afterwards.
 */
export async function withSsh<T>(
  input: SshOptions,
  privateKey: Buffer,
  signal: AbortSignal,
  use: (remote: Remote) => Promise<T>,
): Promise<T> {
  const options = parseOptions(input)
  if (signal.aborted) {
    throw new SshError({ kind: 'cancelled' })
  }
  const client = new Client()
  const handshake: Handshake = { observed: undefined }
  const link = new Link()
  client.on('error', () => link.lose())
  client.once('close', () => link.lose())
  const abort = () => {
    link.lose()
    client.destroy()
  }
  signal.addEventListener('abort', abort, {
    once: true,
  })
  try {
    try {
      await connect(client, options, privateKey, handshake)
    } catch (error: unknown) {
      throw connectionFailure(error, options, handshake, signal)
    }
    return await use(createRemote(client, options, signal, link))
  } finally {
    signal.removeEventListener('abort', abort)
    client.destroy()
  }
}
