import { basename } from 'node:path'
import { InstallerError } from '../../diagnostic/error'
import { openChildDir, readChild, writeChild, type Dir } from '../../state/files'
import { sameIdentity } from '../auth/identity'
import { stateFailure } from '../errors'
import { isErrorCode } from '../guards'
import { userId } from '../host'
import { requireOperationLock } from '../root'
import { AWS_SPEC } from '../spec'
import { isOperationId, type AwsIdentity } from '../types'
import { requireTransition } from './transitions'
import { isDeployment, type Deployment } from './types'

function invalid(): never {
  throw new InstallerError({
    code: 'AWS_DEPLOYMENT_STATE_INVALID',
  })
}

function ownership() {
  return {
    owner: userId(),
    mode: 0o700,
  }
}

export function parse(value: unknown): Deployment {
  if (!isDeployment(value)) {
    return invalid()
  }
  return value
}

async function optional(open: () => Promise<Dir>, create: boolean): Promise<Dir | null> {
  try {
    return await open()
  } catch (error: unknown) {
    if (!create && isErrorCode(error, 'ENOENT')) {
      return null
    }
    throw stateFailure(error)
  }
}

async function openStore(root: Dir, create: boolean): Promise<Dir | null> {
  return await optional(() => openChildDir(root, AWS_SPEC.state.deployments, ownership(), create), create)
}

async function openDirectory(root: Dir, id: string, create = false): Promise<Dir | null> {
  if (!isOperationId(id)) {
    return invalid()
  }
  const store = await openStore(root, create)
  if (!store) {
    return null
  }
  return await optional(() => openChildDir(store, id, ownership(), create), create)
}

async function load(directory: Dir): Promise<Deployment> {
  try {
    const snapshot = await readChild(directory, AWS_SPEC.state.deployment, {
      owner: userId(),
      mode: 0o600,
      minSize: 1,
      maxSize: AWS_SPEC.limits.record,
    })
    const record = parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes)) as unknown)
    if (record.id !== basename(directory.path)) {
      return invalid()
    }
    return record
  } catch (error: unknown) {
    // A missing or unreadable record never establishes that no effects occurred.
    if (error instanceof InstallerError) {
      throw error
    }
    return invalid()
  }
}

/** Evidence is never pruned, so a record that would outgrow its bound is refused before writing. */
async function write(directory: Dir, record: Deployment): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(parse(record), null, 2)}\n`)
  if (bytes.byteLength > AWS_SPEC.limits.record) {
    return invalid()
  }
  try {
    await writeChild(directory, AWS_SPEC.state.deployment, bytes, 0o600)
  } catch (error: unknown) {
    throw stateFailure(error)
  }
}

/** Stores a newly approved deployment. Its directory must not already hold anything. */
export async function create(root: Dir, record: Deployment): Promise<void> {
  await requireOperationLock(root)
  const initial = parse(record)
  if (
    initial.steps.length !== 0 ||
    initial.removals.length !== 0 ||
    initial.latest !== null ||
    initial.termination !== 'confirmed'
  ) {
    return invalid()
  }
  const directory = await openDirectory(root, initial.id, true)
  if (!directory || (await directory.list()).length !== 0) {
    return invalid()
  }
  await write(directory, initial)
}

/**
 * Lock-free so status can show evidence while an operation is running. A
 * strictly empty directory holds no approval, so it has no record and no
 * effects. Any other incomplete directory fails closed.
 */
export async function read(root: Dir, id: string): Promise<Deployment | null> {
  const directory = await openDirectory(root, id)
  if (!directory || (await directory.list()).length === 0) {
    return null
  }
  return await load(directory)
}

/**
 * Replaces the record only through a permitted transition, under the
 * operation lock held by this process.
 */
export async function save(root: Dir, updated: Deployment): Promise<void> {
  await requireOperationLock(root)
  const next = parse(updated)
  const directory = await openDirectory(root, next.id)
  if (!directory) {
    return invalid()
  }
  requireTransition(await load(directory), next)
  await write(directory, next)
}

/** Any unreadable or incomplete deployment fails the whole listing; an empty directory is skipped. */
export async function list(root: Dir): Promise<Deployment[]> {
  const store = await openStore(root, false)
  if (!store) {
    return []
  }
  const records: Deployment[] = []
  for (const id of await store.list()) {
    const record = await read(root, id)
    if (record) {
      records.push(record)
    }
  }
  return records
}

/** Matches by account, operator ARN, and immutable user ID, not by connection name. */
export async function bound(root: Dir, identity: AwsIdentity): Promise<Deployment[]> {
  return (await list(root)).filter(record => sameIdentity(record.binding.operator, identity))
}
