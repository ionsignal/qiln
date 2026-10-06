import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { get, type RequestOptions } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { InstallerError } from '../../diagnostic/error'
import type { Dir } from '../../state/files'
import { userId } from '../state'
import { TOOL_SPEC, validateArtifact, type Artifact } from './spec'

export interface DownloadOptions {
  signal?: AbortSignal
  progress?: (received: number, total: number) => void
}

export class DownloadError extends Error {
  constructor(
    public readonly failure: InstallerError,
    public readonly fileClosed: boolean,
  ) {
    super(failure.message)
    this.name = 'DownloadError'
  }
}

function approvedUrl(value: string): URL {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.hostname !== TOOL_SPEC.host ||
    (url.port !== '' && url.port !== '443') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    throw new InstallerError({
      code: 'AWS_TOOL_DOWNLOAD_FAILED',
      facts: [['Observed', 'The download or redirect violated the approved HTTPS host policy.']],
    })
  }
  return url
}

function response(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const options: RequestOptions = {
      agent: false,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      signal,
      headers: {
        Accept: 'application/octet-stream',
        'Accept-Encoding': 'identity',
        'User-Agent': 'qiln-managed-aws-cli',
      },
    }
    const request = get(url, options, resolve)
    request.on('error', reject)
  })
}

async function write(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null)
    if (result.bytesWritten === 0) {
      throw new InstallerError({
        code: 'AWS_TOOL_DOWNLOAD_FAILED',
      })
    }
    offset += result.bytesWritten
  }
}

function check(signal: AbortSignal): void {
  if (signal.aborted) {
    const reason: unknown = signal.reason
    throw reason instanceof InstallerError
      ? reason
      : new InstallerError({
          code: 'COMMAND_CANCELLED',
        })
  }
}

/**
 * The caller owns workspace cleanup. This function does not return until its
 * file handling has finished, including after cancellation or verification
 * failure.
 */
export async function download(
  artifact: Artifact,
  directory: Dir,
  name: string,
  options: DownloadOptions = {},
): Promise<string> {
  validateArtifact(artifact)
  const controller = new AbortController()
  const cancel = () => {
    controller.abort(
      new InstallerError({
        code: 'COMMAND_CANCELLED',
      }),
    )
  }
  options.signal?.addEventListener('abort', cancel, {
    once: true,
  })
  if (options.signal?.aborted) {
    cancel()
  }
  const deadline = setTimeout(() => {
    controller.abort(
      new InstallerError({
        code: 'AWS_TOOL_DOWNLOAD_TIMEOUT',
      }),
    )
  }, TOOL_SPEC.downloadTimeoutMs)
  const path = directory.child(name)
  let handle: FileHandle | undefined
  let failure: InstallerError | undefined
  let fileClosed = true
  try {
    check(controller.signal)
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    fileClosed = false
    await handle.chmod(0o600)
    let url = approvedUrl(artifact.url)
    let redirects = 0
    let received = 0
    const hash = createHash('sha256')
    while (true) {
      check(controller.signal)
      const incoming = await response(url, controller.signal)
      const abort = () => incoming.destroy()
      controller.signal.addEventListener('abort', abort, {
        once: true,
      })
      try {
        check(controller.signal)
        const status = incoming.statusCode ?? 0
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = incoming.headers.location
          if (location === undefined || redirects >= TOOL_SPEC.redirects) {
            throw new InstallerError({
              code: 'AWS_TOOL_DOWNLOAD_FAILED',
              facts: [['Observed', 'The response exceeded the redirect policy or omitted its destination.']],
            })
          }
          url = approvedUrl(new URL(location, url).href)
          redirects++
          continue
        }
        if (
          status !== 200 ||
          (incoming.headers['content-encoding'] !== undefined && incoming.headers['content-encoding'] !== 'identity')
        ) {
          throw new InstallerError({
            code: 'AWS_TOOL_DOWNLOAD_FAILED',
            facts: [['Observed', `The artifact request returned an unsupported HTTP response (${status}).`]],
          })
        }
        const length = incoming.headers['content-length']
        if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) !== artifact.bytes)) {
          throw new InstallerError({
            code: 'AWS_TOOL_VERIFICATION_FAILED',
            facts: [['Observed', 'The declared artifact length differs from the committed byte count.']],
          })
        }
        for await (const chunk of incoming) {
          const bytes: unknown = chunk
          check(controller.signal)
          if (!Buffer.isBuffer(bytes)) {
            throw new InstallerError({
              code: 'AWS_TOOL_DOWNLOAD_FAILED',
            })
          }
          received += bytes.byteLength
          if (received > artifact.bytes || received > TOOL_SPEC.maximumArtifactBytes) {
            throw new InstallerError({
              code: 'AWS_TOOL_VERIFICATION_FAILED',
              facts: [['Observed', 'The artifact exceeded its committed byte count.']],
            })
          }
          hash.update(bytes)
          await write(handle, bytes)
          check(controller.signal)
          options.progress?.(received, artifact.bytes)
        }
        break
      } finally {
        controller.signal.removeEventListener('abort', abort)
        incoming.destroy()
      }
    }
    check(controller.signal)
    if (received !== artifact.bytes || hash.digest('hex') !== artifact.sha256) {
      throw new InstallerError({
        code: 'AWS_TOOL_VERIFICATION_FAILED',
        facts: [['Observed', 'The downloaded bytes do not match the committed artifact identity.']],
      })
    }
    await handle.sync()
    const metadata = await handle.stat()
    if (
      !metadata.isFile() ||
      metadata.uid !== userId() ||
      (metadata.mode & 0o7777) !== 0o600 ||
      metadata.size !== artifact.bytes
    ) {
      throw new InstallerError({
        code: 'AWS_TOOL_VERIFICATION_FAILED',
      })
    }
    check(controller.signal)
  } catch (error: unknown) {
    const reason: unknown = controller.signal.reason
    failure =
      controller.signal.aborted && reason instanceof InstallerError
        ? reason
        : error instanceof InstallerError
          ? error
          : new InstallerError({
              code: 'AWS_TOOL_DOWNLOAD_FAILED',
            })
  } finally {
    if (handle) {
      try {
        await handle.close()
        fileClosed = true
      } catch {
        failure ??= new InstallerError({
          code: 'AWS_TOOL_CLEANUP_FAILED',
          facts: [['Observed', 'The downloaded artifact file could not be confirmed closed.']],
        })
      }
    }
    clearTimeout(deadline)
    options.signal?.removeEventListener('abort', cancel)
  }
  if (!failure && controller.signal.aborted) {
    const reason: unknown = controller.signal.reason
    failure =
      reason instanceof InstallerError
        ? reason
        : new InstallerError({
            code: 'COMMAND_CANCELLED',
          })
  }
  if (failure) {
    throw new DownloadError(failure, fileClosed)
  }
  return path
}
