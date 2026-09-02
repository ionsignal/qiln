import { constants } from 'node:fs'
import { lstat, open, unlink, type FileHandle } from 'node:fs/promises'
import { QilnInstallerError } from '../error'
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
    throw new QilnInstallerError({
      code: 'UNSUPPORTED_PLATFORM',
      check: 'installer lock ownership',
      summary: 'Qiln cannot determine the invoking effective user ID.',
      observed: `Node platform '${process.platform}' does not expose process.geteuid().`,
      reason: 'The installer lock must belong to the unprivileged invoking developer.',
      operatorAction: 'Run Qiln on the supported Ubuntu host as the invoking developer.',
      rerun: 'qiln doctor',
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
    throw new QilnInstallerError({
      code: 'INSTALLER_LOCK_CHANGED',
      check: 'exclusive installer lock',
      summary: 'The installer lock changed while qiln up was running.',
      observed: 'The lock path no longer identifies the regular file created by this installer execution.',
      reason: 'Qiln must not remove a lock that it can no longer prove it owns.',
      operatorAction:
        'Inspect the protected installer state directory manually. Do not remove a lock until no Qiln installer process is active.',
      rerun: 'qiln doctor',
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
      throw new QilnInstallerError({
        code: 'INSTALLER_LOCKED',
        check: 'exclusive installer execution',
        summary: 'Another Qiln installer execution may already be active.',
        observed: `The protected installer lock '${INSTALLER_SPEC.state.lockFileName}' already exists.`,
        reason: 'Qiln acquires the installer lock immediately and never waits for or breaks a potentially stale lock.',
        operatorAction:
          'Confirm that no qiln up process is active. Inspect the state directory manually before deciding whether an old lock can be removed.',
        rerun: 'qiln doctor',
      })
    }
    throw new QilnInstallerError({
      code: 'INSTALLER_LOCK_FAILED',
      check: 'exclusive installer execution',
      summary: 'The protected installer lock could not be created.',
      observed: 'Qiln could not exclusively create its installer lock in the validated state directory.',
      reason: 'Incus mutations and installation-state writes must not run concurrently.',
      operatorAction: 'Inspect the protected installer state directory ownership and permissions manually.',
      rerun: 'qiln doctor',
      cause: error,
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
    throw new QilnInstallerError({
      code: 'INSTALLER_LOCK_FAILED',
      check: 'exclusive installer execution',
      summary: 'The protected installer lock could not be validated.',
      observed: 'The newly created installer lock did not retain its required regular-file ownership and mode.',
      reason: 'Qiln cannot safely serialize Incus mutations without a validated lock.',
      operatorAction:
        'Inspect the protected installer state directory manually. The lock is intentionally retained for review.',
      rerun: 'qiln doctor',
      cause: error,
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
