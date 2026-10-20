import { createReadStream, type ReadStream } from 'node:fs'
import { Transform } from 'node:stream'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { SshError } from './failure'
import type { Link } from './link'
import type { Client, SFTPWrapper } from 'ssh2'

const PROGRESS_INTERVAL_MS = 10_000

/**
 * `bytes` is the exact approved size, not a ceiling: more or fewer local bytes
 * than approved fail the transfer. Progress is observational and never proves
 * that the remote file was written or closed.
 */
export interface UploadOptions {
  timeoutMs: number
  bytes: number
  onProgress?: (sent: number) => void
}

export interface UploadResult {
  bytes: number
  sha256: string
}

/**
 * Carries only authored wording, so no library or server message reaches a
 * diagnostic.
 */
class Refusal extends Error {
  constructor(public readonly reason: string) {
    super(reason)
    this.name = 'Refusal'
  }
}

/**
 * Counts and hashes exactly the bytes handed to the remote writer. A chunk that
 * would exceed the approved count is rejected before it is forwarded.
 */
function createMeter(expected: number, onProgress?: (sent: number) => void) {
  const hash = createHash('sha256')
  let sent = 0
  let reported = Date.now()
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (sent + chunk.byteLength > expected) {
        callback(new Refusal('the local file is larger than the approved byte count'))
        return
      }
      sent += chunk.byteLength
      hash.update(chunk)
      if (onProgress && Date.now() - reported >= PROGRESS_INTERVAL_MS) {
        reported = Date.now()
        try {
          onProgress(sent)
        } catch {
          // Observers never decide the outcome of a transfer.
        }
      }
      callback(null, chunk)
    },
    flush(callback) {
      callback(sent === expected ? null : new Refusal('the local file ended before the approved byte count'))
    },
  })
  return {
    stream,
    sent: () => sent,
    digest: () => hash.digest('hex'),
  }
}

/**
 * Resolves with the subsystem, or rejects once the transfer has ended. A late
 * callback releases the subsystem it receives and never restarts work.
 */
function openSftp(client: Client, signal: AbortSignal, onError: () => void): Promise<SFTPWrapper> {
  return new Promise<SFTPWrapper>((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      settled = true
      reject(new Refusal('the SFTP subsystem was not ready before the transfer ended'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      client.sftp((error, sftp) => {
        signal.removeEventListener('abort', onAbort)
        if (error) {
          if (!settled) {
            settled = true
            reject(new Refusal('the SFTP subsystem was not opened'))
          }
          return
        }
        sftp.on('error', onError)
        if (settled) {
          sftp.end()
          return
        }
        settled = true
        resolve(sftp)
      })
    } catch {
      signal.removeEventListener('abort', onAbort)
      settled = true
      reject(new Refusal('the SFTP subsystem could not be requested'))
    }
  })
}

/**
 * The local descriptor is closed only when the read stream reports `close`;
 * `destroy()` merely starts the shutdown.
 */
function release(reader: ReadStream): Promise<void> {
  if (reader.closed) {
    return Promise.resolve()
  }
  return new Promise<void>(resolve => {
    reader.once('close', () => resolve())
    reader.destroy()
  })
}

/**
 * Uploads one local file to a new remote file under one deadline that spans
 * SFTP acquisition, OPEN, transfer, and the successful remote CLOSE. The remote
 * file is created exclusively with mode 0600. Success needs the pipeline and
 * the write stream's own successful close: `finish` alone does not prove the
 * remote handle was closed. Any failure invalidates the shared connection, and
 * nothing is retried, resumed, replaced, or deleted remotely.
 */
export async function uploadFile(
  client: Client,
  link: Link,
  signal: AbortSignal,
  localPath: string,
  remotePath: string,
  options: UploadOptions,
): Promise<UploadResult> {
  const stop = new AbortController()
  let reason: string | undefined
  let started = false
  let sftp: SFTPWrapper | undefined
  let reader: ReadStream | undefined
  const abort = (why: string) => {
    reason ??= why
    stop.abort()
  }
  const expired = new Promise<never>((_resolve, reject) => {
    stop.signal.addEventListener('abort', () => reject(new Refusal(reason ?? 'the transfer ended')), { once: true })
  })
  const unwatch = link.watch(() => abort('the connection was lost'))
  const timer = setTimeout(() => abort('the transfer deadline was exceeded'), options.timeoutMs)
  const meter = createMeter(options.bytes, options.onProgress)
  try {
    sftp = await openSftp(client, stop.signal, () => abort('the SFTP channel failed'))
    reader = createReadStream(localPath)
    const writer = sftp.createWriteStream(remotePath, { flags: 'wx', mode: 0o600, autoClose: true })
    started = true
    const closed = new Promise<void>((resolve, reject) => {
      writer.once('close', () => resolve())
      writer.on('error', reject)
    })
    await Promise.race([Promise.all([pipeline(reader, meter.stream, writer, { signal: stop.signal }), closed]), expired])
    return { bytes: meter.sent(), sha256: meter.digest() }
  } catch (error: unknown) {
    // The cause is fixed before the shared link is invalidated, so watchers
    // cannot replace it with a less specific one.
    const why = reason ?? (error instanceof Refusal ? error.reason : 'the local read or remote write failed')
    reason = why
    link.lose()
    client.destroy()
    throw new SshError({
      kind: signal.aborted ? 'cancelled' : 'transfer',
      remoteStarted: started,
      facts: [['Transfer failure', why]],
    })
  } finally {
    clearTimeout(timer)
    unwatch()
    try {
      sftp?.end()
    } catch {
      // Ending the subsystem channel is best effort; the connection owner destroys the client.
    }
    if (reader) {
      await release(reader)
    }
  }
}
