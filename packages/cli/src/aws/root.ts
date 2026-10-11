import { InstallerError } from '../diagnostic/error'
import { createDir, openChildDir, openDir, readChild, type Dir } from '../state/files'
import { acquireLock, type StateLock } from '../state/lock'
import { statePath } from '../state/path'
import { stateFailure } from './errors'
import { isErrorCode } from './guards'
import { requireAwsHost, userId } from './host'
import { lockRecovery, terminationConfirmed } from './recovery'
import { AWS_SPEC } from './spec'

export interface AwsState {
  root: Dir
  connections: Dir
}

/**
 * Tools, connections, and deployments share protected AWS-root access. Only
 * connections and deployments share the AWS-operation lock. Read-only callers
 * return null when either required directory is absent.
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
  const root = await openAwsRoot()
  if (!root) {
    return null
  }
  try {
    if ((await root.list()).includes(AWS_SPEC.state.lock)) {
      throw new InstallerError({
        code: 'AWS_LOCKED',
        facts: [['Observed', `The protected AWS operation lock '${AWS_SPEC.state.lock}' already exists.`]],
        retry: 'qiln aws status',
      })
    }
    return await openChildDir(root, AWS_SPEC.state.connections, {
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

/**
 * Confirms that the lock file still names the expected process. A parent
 * passes its own PID; a credential child passes its parent's. PID, age, or a
 * received reply never establishes that a lock is stale.
 */
export async function requireOperationLock(root: Dir, pid = process.pid): Promise<void> {
  const snapshot = await readChild(root, AWS_SPEC.state.lock, {
    owner: userId(),
    mode: 0o600,
    minSize: 1,
    maxSize: 64,
  })
  if (Buffer.from(snapshot.bytes).toString('utf8') !== `${pid}\n`) {
    throw new InstallerError({
      code: 'AWS_LOCK_CHANGED',
    })
  }
}

/**
 * Runs one command under the exclusive AWS-operation lock. Acquire it once at
 * the command's outer boundary and hold it through approval prompts, child
 * activity, and evidence persistence. Contention fails immediately. The lock is
 * released only when child termination is confirmed.
 */
export async function withAwsOperation<T>(create: boolean, run: (state: AwsState) => Promise<T>): Promise<T> {
  const root = await openAwsRoot(create)
  if (!root) {
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
    lock = await acquireLock(root, {
      name: AWS_SPEC.state.lock,
      label: 'AWS operation',
      retry: 'qiln aws status',
      codes: {
        changed: 'AWS_LOCK_CHANGED',
        locked: 'AWS_LOCKED',
        failed: 'AWS_LOCK_FAILED',
      },
    })
    const connections = await openChildDir(root, AWS_SPEC.state.connections, ownership, create)
    return await run({
      root,
      connections,
    })
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
              facts: [['Observed', 'Operation-lock release or directory synchronization was not confirmed.']],
            }),
        )
      }
    }
  }
}
