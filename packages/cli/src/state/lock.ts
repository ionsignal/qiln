import { constants } from 'node:fs'
import { lstat, open, unlink, type FileHandle } from 'node:fs/promises'
import { InstallerError, type InstallerErrorCode } from '../diagnostic/error'
import { Dir } from './files'

export interface StateLock {
  release(): Promise<void>
}

export type InstallerLock = StateLock

export interface LockOptions {
  name: string
  label: string
  retry: string
  codes: {
    changed: InstallerErrorCode
    locked: InstallerErrorCode
    failed: InstallerErrorCode
  }
}

function isErrorCode(value: unknown, code: string): boolean {
  return typeof value === 'object' && value !== null && 'code' in value && value.code === code
}

function currentUserId(): number {
  if (typeof process.geteuid !== 'function') {
    throw new InstallerError({
      code: 'UNSUPPORTED_PLATFORM',
      facts: [['Observed', `Node platform '${process.platform}' does not expose process.geteuid().`]],
      retry: 'qiln doctor',
    })
  }
  return process.geteuid()
}

async function removeOwnedLock(path: string, handle: FileHandle, options: LockOptions): Promise<void> {
  const opened = await handle.stat()
  const current = await lstat(path)
  if (
    !opened.isFile() ||
    !current.isFile() ||
    opened.dev !== current.dev ||
    opened.ino !== current.ino ||
    current.uid !== currentUserId() ||
    (current.mode & 0o7777) !== 0o600
  ) {
    throw new InstallerError({
      code: options.codes.changed,
      facts: [['Observed', `The ${options.label} lock no longer identifies the file created by this execution.`]],
      retry: options.retry,
    })
  }
  await unlink(path)
}

/**
 * Acquires a lock by exclusively creating one protected state entry. Existing
 * locks are never waited on, removed, or treated as stale. The directory
 * pathname is trusted; the retained file handle identifies the lock that this
 * execution may release.
 */
export async function acquireLock(directory: Dir, options: LockOptions): Promise<StateLock> {
  const path = directory.child(options.name)
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  } catch (error: unknown) {
    if (isErrorCode(error, 'EEXIST')) {
      throw new InstallerError({
        code: options.codes.locked,
        facts: [['Observed', `The protected ${options.label} lock '${options.name}' already exists.`]],
        retry: options.retry,
      })
    }
    throw new InstallerError({
      code: options.codes.failed,
      facts: [['Observed', `Qiln could not exclusively create its ${options.label} lock.`]],
      retry: options.retry,
    })
  }
  try {
    await handle.chmod(0o600)
    await handle.writeFile(`${process.pid}\n`, {
      encoding: 'utf8',
    })
    await handle.sync()
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.uid !== currentUserId() || (metadata.mode & 0o7777) !== 0o600) {
      throw new Error('State lock validation failed.')
    }
    await directory.sync()
  } catch (error: unknown) {
    await handle.close().catch(() => undefined)
    throw new InstallerError({
      code: options.codes.failed,
      facts: [['Observed', `The newly created ${options.label} lock did not retain its required ownership and mode.`]],
      retry: options.retry,
    })
  }
  let released = false
  return {
    async release(): Promise<void> {
      if (released) {
        return
      }
      released = true
      try {
        await removeOwnedLock(path, handle, options)
        await directory.sync()
      } finally {
        await handle.close()
      }
    },
  }
}
