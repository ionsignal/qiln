import { Client } from 'ssh2'
import { SshError } from './failure'
import { fingerprintOf } from './key'
import { Link } from './link'
import {
  execLimitsSchema,
  parseLimits,
  parseOptions,
  uploadLimitsSchema,
  type ExecLimits,
  type SshOptions,
} from './options'
import { uploadFile, type UploadOptions, type UploadResult } from './upload'
import type { DiagnosticFact } from '../diagnostic/error'

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
 * An upload creates one new remote file exclusively and is judged complete only
 * after its remote close. Any failure invalidates the connection, so later
 * calls fail as a lost connection.
 */
export interface Remote {
  exec(command: string, limits?: Partial<ExecLimits>): Promise<CommandResult>
  upload(localPath: string, remotePath: string, request: UploadOptions): Promise<UploadResult>
}

interface Handshake {
  observed: string | undefined
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
      kind: 'hostkey',
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
    upload: async (localPath, remotePath, request) => {
      const limits = parseLimits(uploadLimitsSchema, {
        timeoutMs: request.timeoutMs,
        bytes: request.bytes,
      })
      if (signal.aborted) {
        throw new SshError({ kind: 'cancelled' })
      }
      if (link.lost) {
        throw new SshError({ kind: 'connection', facts: endpointFacts(options) })
      }
      return await uploadFile(client, link, signal, localPath, remotePath, {
        ...limits,
        onProgress: request.onProgress,
      })
    },
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
