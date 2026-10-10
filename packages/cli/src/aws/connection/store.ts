import { InstallerError } from '../../diagnostic/error'
import { createDir, openChildDir, openDir, type Dir } from '../../state/files'
import { acquireLock, type StateLock } from '../../state/lock'
import { statePath } from '../../state/path'
import { requireAwsHost, userId } from '../host'
import { stateFailure } from '../errors'
import { lockRecovery, terminationConfirmed } from '../recovery'
import { isErrorCode } from '../guards'
import { AWS_SPEC } from '../spec'

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

/**
 * Preliminary inspection provides guidance only. Authentication and removal
 * must re-read their records inside the existing locked transaction.
 */
export async function openExistingConnections(): Promise<Dir | null> {
  const aws = await openAwsRoot()
  if (!aws) {
    return null
  }
  try {
    if ((await aws.list()).includes(AWS_SPEC.state.lock)) {
      throw new InstallerError({
        code: 'AWS_LOCKED',
        facts: [['Observed', `The protected AWS connection state lock '${AWS_SPEC.state.lock}' already exists.`]],
        retry: 'qiln aws status',
      })
    }
    return await openChildDir(aws, AWS_SPEC.state.connections, {
      owner: userId(),
      mode: 0o700,
    })
  } catch (error: unknown) {
    if (isErrorCode(error, 'ENOENT')) {
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
