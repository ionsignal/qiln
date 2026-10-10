import { rm } from 'node:fs/promises'
import { basename } from 'node:path'
import { InstallerError } from '../../diagnostic/error'
import { inspectChild, openChildDir, readChild, writeChild, type Dir } from '../../state/files'
import { sameIdentity } from '../auth/identity'
import { Session } from '../auth/session'
import { stateFailure } from '../errors'
import { isErrorCode } from '../guards'
import { isPending, type Pending } from '../iam/types'
import { AWS_SPEC } from '../spec'
import { userId } from '../host'
import { isConnection, validName, type AwsConnection } from '../types'

export async function names(directory: Dir): Promise<string[]> {
  const entries = await directory.list()
  if (entries.some(name => !validName(name))) {
    throw new InstallerError({
      code: 'AWS_STATE_INVALID',
    })
  }
  return entries
}

async function readJson(directory: Dir, name: string): Promise<unknown | null> {
  if (!(await directory.list()).includes(name)) {
    return null
  }
  try {
    const snapshot = await readChild(directory, name, {
      owner: userId(),
      mode: 0o600,
      minSize: 1,
      maxSize: AWS_SPEC.limits.record,
    })
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes)) as unknown
  } catch (error: unknown) {
    throw stateFailure(error)
  }
}

export async function read(directory: Dir, name: string): Promise<AwsConnection | null> {
  const value = await readJson(directory, AWS_SPEC.state.connection)
  if (value === null) {
    return null
  }
  if (!isConnection(value) || value.name !== name) {
    throw new InstallerError({
      code: 'AWS_STATE_INVALID',
      facts: [['Layout', 'Unsupported connection layouts are retained untouched and require reviewed recovery.']],
    })
  }
  return value
}

export async function pending(directory: Dir): Promise<Pending | null> {
  const value = await readJson(directory, AWS_SPEC.state.pending)
  if (value === null) {
    return null
  }
  if (!isPending(value) || value.name !== basename(directory.path)) {
    throw new InstallerError({
      code: 'AWS_PERMISSION_STATE_INVALID',
    })
  }
  return value
}

function requireBindings(connection: AwsConnection | null, operation: Pending): void {
  if (connection === null) {
    if (operation.kind === 'maintain') {
      throw new InstallerError({
        code: 'AWS_PERMISSION_STATE_INVALID',
      })
    }
    return
  }
  const managed = connection.managed
  if (
    operation.operator === null ||
    !sameIdentity(connection.identity, operation.operator) ||
    managed === null ||
    managed.creationId !== operation.creationId ||
    managed.permissionRegion !== operation.region
  ) {
    throw new InstallerError({
      code: 'AWS_PERMISSION_STATE_INVALID',
    })
  }
  const approvedPolicy = operation.approval?.inspection.before?.prior.policy
  if (
    approvedPolicy &&
    (managed.foundation?.arn !== approvedPolicy.arn || managed.foundation.id !== approvedPolicy.id)
  ) {
    throw new InstallerError({
      code: 'AWS_PERMISSION_STATE_INVALID',
    })
  }
  if (
    operation.foundation !== null &&
    managed.foundation !== null &&
    (operation.foundation.arn !== managed.foundation.arn || operation.foundation.id !== managed.foundation.id)
  ) {
    throw new InstallerError({
      code: 'AWS_PERMISSION_STATE_INVALID',
    })
  }
  if (
    operation.kind === 'onboard' &&
    (operation.verified === null ||
      managed.foundation?.arn !== operation.foundation?.arn ||
      managed.foundation?.id !== operation.foundation?.id ||
      JSON.stringify(managed.verified) !== JSON.stringify(operation.verified))
  ) {
    throw new InstallerError({
      code: 'AWS_PERMISSION_STATE_INVALID',
    })
  }
}

/**
 * Reject old layouts before callers replace credentials or write current state.
 * A matching IAM name cannot turn an unsupported record into a trusted binding.
 */
export async function inspect(directory: Dir): Promise<void> {
  const entries = await directory.list()
  const allowed = [
    AWS_SPEC.state.connection,
    AWS_SPEC.state.pending,
    AWS_SPEC.state.auth,
    AWS_SPEC.state.root,
  ]
  if (entries.some(name => !allowed.includes(name))) {
    throw new InstallerError({
      code: 'AWS_STATE_INVALID',
      facts: [['Layout', 'Unsupported state is retained untouched; no migration or local removal was attempted.']],
    })
  }
  for (const name of entries) {
    const kind = await inspectChild(directory, name, {
      owner: userId(),
      fileMode: 0o600,
      directoryMode: 0o700,
      maxFileSize: AWS_SPEC.limits.record,
    })
    if ((name === AWS_SPEC.state.auth || name === AWS_SPEC.state.root) !== (kind === 'directory')) {
      throw new InstallerError({
        code: 'AWS_STATE_INVALID',
      })
    }
  }
  const connection = await read(directory, basename(directory.path))
  const operation = await pending(directory)
  if (operation) {
    requireBindings(connection, operation)
  }
  if (entries.includes(AWS_SPEC.state.root)) {
    if (!operation || operation.cleanup === 'completed') {
      throw new InstallerError({
        code: 'AWS_PERMISSION_STATE_INVALID',
      })
    }
    const root = await openChildDir(directory, AWS_SPEC.state.root, {
      owner: userId(),
      mode: 0o700,
    })
    const rootEntries = await root.list()
    if (rootEntries.some(name => name !== AWS_SPEC.state.auth)) {
      throw new InstallerError({
        code: 'AWS_PERMISSION_STATE_INVALID',
      })
    }
    if (rootEntries.includes(AWS_SPEC.state.auth)) {
      await Session.open(root, operation.region)
    }
  }
}

export async function open(directory: Dir, name: string, create = false): Promise<Dir> {
  if (!validName(name)) {
    throw new InstallerError({
      code: 'AWS_CONNECTION_NAME_INVALID',
    })
  }
  try {
    const connection = await openChildDir(
      directory,
      name,
      {
        owner: userId(),
        mode: 0o700,
      },
      create,
    )
    await inspect(connection)
    return connection
  } catch (error: unknown) {
    if (isErrorCode(error, 'ENOENT')) {
      throw new InstallerError({
        code: 'AWS_CONNECTION_NOT_FOUND',
        facts: [['Connection', name]],
        retry: 'qiln aws connect',
      })
    }
    throw stateFailure(error)
  }
}

export async function save(directory: Dir, connection: AwsConnection): Promise<void> {
  if (!isConnection(connection) || connection.name !== basename(directory.path)) {
    throw new InstallerError({
      code: 'AWS_STATE_INVALID',
    })
  }
  const previous = await read(directory, connection.name)
  if (
    previous &&
    (!sameIdentity(previous.identity, connection.identity) ||
      previous.createdAt !== connection.createdAt ||
      (previous.managed === null) !== (connection.managed === null) ||
      (previous.managed !== null &&
        connection.managed !== null &&
        (previous.managed.creationId !== connection.managed.creationId ||
          previous.managed.permissionRegion !== connection.managed.permissionRegion ||
          (previous.managed.foundation !== null &&
            (previous.managed.foundation.arn !== connection.managed.foundation?.arn ||
              previous.managed.foundation.id !== connection.managed.foundation?.id)))))
  ) {
    throw new InstallerError({
      code: 'AWS_IDENTITY_MISMATCH',
    })
  }
  try {
    await writeChild(directory, AWS_SPEC.state.connection, Buffer.from(`${JSON.stringify(connection, null, 2)}\n`), 0o600)
  } catch (error: unknown) {
    throw stateFailure(error)
  }
}

export async function remove(directory: Dir, name: string): Promise<void> {
  if (!validName(name)) {
    throw new InstallerError({
      code: 'AWS_CONNECTION_NAME_INVALID',
    })
  }
  await rm(directory.child(name), {
    recursive: true,
  })
  await directory.sync()
  if ((await directory.list()).includes(name)) {
    throw new InstallerError({
      code: 'AWS_CLEANUP_FAILED',
    })
  }
}
