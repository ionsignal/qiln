import { constants } from 'node:fs'
import { lstat, open, unlink, type FileHandle } from 'node:fs/promises'
import { InstallerError } from '../diagnostic/error'
import { Dir } from './files'
import { INSTALLER_SPEC } from './spec'

export interface InstallerLock {
  release(): Promise<void>
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

async function removeOwnedLock(path: string, handle: FileHandle): Promise<void> {
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
      code: 'INSTALLER_LOCK_CHANGED',
      facts: [['Observed', 'The lock path no longer identifies the regular file created by this installer execution.']],
      retry: 'qiln doctor',
    })
  }
  await unlink(path)
}

/**
 * Acquires the installer lock by exclusively creating one protected state
 * entry. Existing locks are never waited on, removed, or treated as stale.
 */
export async function acquireInstallerLock(directory: Dir): Promise<InstallerLock> {
  const path = directory.child(INSTALLER_SPEC.state.lockFileName)
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  } catch (error: unknown) {
    if (isErrorCode(error, 'EEXIST')) {
      throw new InstallerError({
        code: 'INSTALLER_LOCKED',
        facts: [['Observed', `The protected installer lock '${INSTALLER_SPEC.state.lockFileName}' already exists.`]],
        retry: 'qiln doctor',
      })
    }
    throw new InstallerError({
      code: 'INSTALLER_LOCK_FAILED',
      facts: [['Observed', 'Qiln could not exclusively create its installer lock in the validated state directory.']],
      retry: 'qiln doctor',
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
      throw new Error('Installer lock validation failed.')
    }
    await directory.sync()
  } catch (error: unknown) {
    await handle.close().catch(() => undefined)
    throw new InstallerError({
      code: 'INSTALLER_LOCK_FAILED',
      facts: [
        ['Observed', 'The newly created installer lock did not retain its required regular-file ownership and mode.'],
      ],
      retry: 'qiln doctor',
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
        await removeOwnedLock(path, handle)
        await directory.sync()
      } finally {
        await handle.close()
      }
    },
  }
}
