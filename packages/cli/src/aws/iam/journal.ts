import { basename, dirname } from 'node:path'
import { InstallerError } from '../../diagnostic/error'
import { openChildDir, openDir, writeChild, type Dir } from '../../state/files'
import * as connections from '../connection/records'
import { userId } from '../host'
import { encodeRecord } from '../../json'
import { requireOperationLock } from '../root'
import { AWS_SPEC } from '../spec'
import type { AwsConnection } from '../types'
import { requireTransition } from './transitions'
import { isPending, type Pending } from './types'

function invalid(): never {
  throw new InstallerError({
    code: 'AWS_PERMISSION_STATE_INVALID',
  })
}

export function parse(value: unknown): Pending {
  if (!isPending(value)) {
    return invalid()
  }
  return value
}

export function copy(record: Pending): Pending {
  return parse(JSON.parse(JSON.stringify(record)) as unknown)
}

export async function read(directory: Dir): Promise<Pending | null> {
  return await connections.pending(directory)
}

export async function requireLock(directory: Dir, expectedPid = process.pid): Promise<void> {
  if (
    !Number.isSafeInteger(expectedPid) ||
    expectedPid <= 0 ||
    basename(dirname(directory.path)) !== AWS_SPEC.state.connections
  ) {
    return invalid()
  }
  const root = await openDir(dirname(dirname(directory.path)), {
    owner: userId(),
    mode: 0o700,
  })
  await requireOperationLock(root, expectedPid)
}

export async function write(directory: Dir, record: Pending): Promise<void> {
  await writeChild(
    directory,
    AWS_SPEC.state.pending,
    encodeRecord(parse(record), 'AWS_PERMISSION_STATE_INVALID', AWS_SPEC.limits.record),
    0o600,
  )
}

/**
 * Replaces the journal only through a permitted transition, under the
 * connection lock held by this process.
 */
export async function save(directory: Dir, record: Pending): Promise<void> {
  await requireLock(directory)
  const current = await read(directory)
  const updated = parse(record)
  if (!current) {
    return invalid()
  }
  requireTransition(current, updated)
  await write(directory, updated)
}

/**
 * Child-side load. The credential child reads its journal and connection
 * record from the parent's locked directory, derived from its own HOME.
 */
export async function childContext(): Promise<{
  record: Pending
  connection: AwsConnection | null
}> {
  const home = process.env.HOME
  if (!home || basename(home) !== AWS_SPEC.state.auth || basename(dirname(home)) !== AWS_SPEC.state.root) {
    return invalid()
  }
  const directory = await openDir(dirname(dirname(home)), {
    owner: userId(),
    mode: 0o700,
  })
  await requireLock(directory, process.ppid)
  await connections.inspect(directory)
  const record = await read(directory)
  if (!record || record.cleanup !== 'pending') {
    return invalid()
  }
  const root = await openChildDir(directory, AWS_SPEC.state.root, {
    owner: userId(),
    mode: 0o700,
  })
  await openChildDir(root, AWS_SPEC.state.auth, {
    owner: userId(),
    mode: 0o700,
  })
  return {
    record,
    connection: await connections.read(directory, record.name),
  }
}
