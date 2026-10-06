import { InstallerError } from '../diagnostic/error'
import { createDir, openChildDir, openDir, type Dir } from '../state/files'
import { acquireLock, type StateLock } from '../state/lock'
import { statePath } from '../state/path'
import { isErrorCode, lockRecovery, stateFailure, terminationConfirmed } from './errors'
import { AWS_SPEC } from './spec'

export function requireAwsHost(): void {
  if (
    (process.platform !== 'linux' && process.platform !== 'darwin') ||
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function'
  ) {
    throw new InstallerError({
      code: 'AWS_PLATFORM_UNSUPPORTED',
    })
  }
  if (process.getuid() === 0 || process.geteuid() === 0) {
    throw new InstallerError({
      code: 'ROOT_EXECUTION_REFUSED',
      retry: 'qiln aws connect',
    })
  }
}

export function userId(): number {
  requireAwsHost()
  const geteuid = process.geteuid
  if (typeof geteuid !== 'function') {
    throw new InstallerError({
      code: 'AWS_PLATFORM_UNSUPPORTED',
    })
  }
  return geteuid()
}

/**
 * Tools and connections share protected AWS-root access, not locks or records.
 * Read-only callers return null when either required directory is absent.
 */
export async function openAwsRoot(create = false): Promise<Dir | null> {
  requireAwsHost()
  const ownership = {
    owner: userId(),
    mode: 0o700,
  }
  const path = statePath(process.env, 'qiln aws connect')
  let root: Dir
  try {
    root = await openDir(path, ownership)
  } catch (error: unknown) {
    if (!isErrorCode(error, 'ENOENT')) {
      throw stateFailure(error)
    }
    if (!create) {
      return null
    }
    try {
      root = await createDir(path, ownership)
    } catch (creationError: unknown) {
      throw stateFailure(creationError)
    }
  }
  try {
    return await openChildDir(root, AWS_SPEC.state.directory, ownership, create)
  } catch (error: unknown) {
    if (!create && isErrorCode(error, 'ENOENT')) {
      return null
    }
    throw stateFailure(error)
  }
}

export async function withAwsState<T>(create: boolean, run: (connections: Dir) => Promise<T>): Promise<T> {
  const aws = await openAwsRoot(create)
  if (!aws) {
    throw new InstallerError({
      code: 'AWS_CONNECTION_NOT_FOUND',
      retry: 'qiln aws connect',
    })
  }
  const ownership = {
    owner: userId(),
    mode: 0o700,
  }
  let lock: StateLock | undefined
  let failure: InstallerError | undefined
  let release = true
  try {
    lock = await acquireLock(aws, {
      name: AWS_SPEC.state.lock,
      label: 'AWS connection state',
      retry: 'qiln aws status',
      codes: {
        changed: 'AWS_LOCK_CHANGED',
        locked: 'AWS_LOCKED',
        failed: 'AWS_LOCK_FAILED',
      },
    })
    const connections = await openChildDir(aws, AWS_SPEC.state.connections, ownership, create)
    return await run(connections)
  } catch (error: unknown) {
    release = terminationConfirmed(error)
    failure = isErrorCode(error, 'ENOENT')
      ? new InstallerError({
          code: 'AWS_CONNECTION_NOT_FOUND',
          retry: 'qiln aws connect',
        })
      : stateFailure(error)
    throw failure
  } finally {
    if (lock && release) {
      try {
        await lock.release()
      } catch {
        throw lockRecovery(
          failure ??
            new InstallerError({
              code: 'AWS_LOCK_FAILED',
              facts: [['Observed', 'Connection-lock release or directory synchronization was not confirmed.']],
            }),
        )
      }
    }
  }
}
