import { SshError } from './failure'
import { fingerprintOf } from './key'
import { Link } from './link'
import { parseOptions, type SshOptions } from './options'
import { SshClient } from './ssh2'
import type { Client } from 'ssh2'
import type { DiagnosticFact } from '../diagnostic/error'

/**
 * Idle channels, such as an Incus operation wait, are otherwise silent, and NAT
 * or security-group tracking can drop an idle flow. A lost keepalive is reported
 * as a lost connection, which fails closed.
 */
const KEEPALIVE_MS = 15_000

export interface SshSession {
  client: Client
  options: SshOptions
  signal: AbortSignal
  link: Link
}

interface Handshake {
  observed: string | undefined
}

function levelOf(error: unknown): unknown {
  return error instanceof Error && 'level' in error ? error.level : undefined
}

export function endpointFacts(options: SshOptions): DiagnosticFact[] {
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
      keepaliveInterval: KEEPALIVE_MS,
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

/**
 * One pinned connection for the duration of `use`. The server must present an
 * Ed25519 host key whose fingerprint equals the pin, and only public-key
 * authentication is attempted. There are no retries or reconnects, and the
 * connection is always destroyed afterwards.
 */
export async function withSession<T>(
  input: SshOptions,
  privateKey: Buffer,
  signal: AbortSignal,
  use: (session: SshSession) => Promise<T>,
): Promise<T> {
  const options = parseOptions(input)
  if (signal.aborted) {
    throw new SshError({ kind: 'cancelled' })
  }
  const client = new SshClient()
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
    return await use({ client, options, signal, link })
  } finally {
    signal.removeEventListener('abort', abort)
    client.destroy()
  }
}
