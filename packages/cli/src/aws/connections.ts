import { rm } from 'node:fs/promises'
import { InstallerError } from '../diagnostic/error'
import { inspectChild, openChildDir, readChild, writeChild, type Dir } from '../state/files'
import { isErrorCode, stateFailure } from './errors'
import { sameIdentity } from './auth/identity'
import { read as readBootstrap } from './bootstrap/state'
import { AWS_SPEC } from './spec'
import { userId } from './state'
import { isConnection, isOperation, validName, type AwsConnection, type AwsIdentity, type AwsOperation } from './types'

export async function names(directory: Dir): Promise<string[]> {
  const entries = await directory.list()
  if (entries.some(name => !validName(name))) {
    throw new InstallerError({
      code: 'AWS_STATE_INVALID',
    })
  }
  return entries
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

export async function inspect(directory: Dir): Promise<void> {
  for (const name of await directory.list()) {
    if (
      ![AWS_SPEC.state.connection, AWS_SPEC.state.operation, AWS_SPEC.state.auth, AWS_SPEC.state.bootstrap].includes(
        name,
      )
    ) {
      throw new InstallerError({
        code: 'AWS_STATE_INVALID',
        facts: [['Observed', 'The connection directory contains an unsupported entry.']],
      })
    }
    const kind = await inspectChild(directory, name, {
      owner: userId(),
      fileMode: 0o600,
      directoryMode: 0o700,
      maxFileSize: AWS_SPEC.limits.record,
    })
    if ((name === AWS_SPEC.state.auth || name === AWS_SPEC.state.bootstrap) !== (kind === 'directory')) {
      throw new InstallerError({
        code: 'AWS_STATE_INVALID',
      })
    }
  }
  await readBootstrap(directory)
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
    return JSON.parse(
      new TextDecoder('utf-8', {
        fatal: true,
      }).decode(snapshot.bytes),
    ) as unknown
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
    })
  }
  return value
}

export async function operation(directory: Dir, name: string): Promise<AwsOperation | null> {
  const value = await readJson(directory, AWS_SPEC.state.operation)
  if (value === null) {
    return null
  }
  if (!isOperation(value) || value.name !== name) {
    throw new InstallerError({
      code: 'AWS_STATE_INVALID',
    })
  }
  return value
}

async function writeJson(directory: Dir, name: string, value: AwsConnection | AwsOperation): Promise<void> {
  try {
    await writeChild(directory, name, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), 0o600)
  } catch (error: unknown) {
    throw stateFailure(error)
  }
}

export async function save(directory: Dir, connection: AwsConnection): Promise<void> {
  if (!isConnection(connection)) {
    throw new InstallerError({
      code: 'AWS_STATE_INVALID',
    })
  }
  await writeJson(directory, AWS_SPEC.state.connection, connection)
}

export async function journal(directory: Dir, operation: AwsOperation): Promise<void> {
  if (!isOperation(operation)) {
    throw new InstallerError({
      code: 'AWS_STATE_INVALID',
    })
  }
  await writeJson(directory, AWS_SPEC.state.operation, operation)
}

export function binding(connection: AwsConnection | null, operation: AwsOperation | null): AwsIdentity | null {
  if (connection && operation?.identity && !sameIdentity(connection.identity, operation.identity)) {
    throw new InstallerError({
      code: 'AWS_STATE_INVALID',
      facts: [['Observed', 'The connection and operation records identify different operators.']],
    })
  }
  return connection?.identity ?? operation?.identity ?? null
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
