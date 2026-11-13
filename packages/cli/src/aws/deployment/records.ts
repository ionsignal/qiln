import { basename } from 'node:path'
import { AWS_SPEC } from '../spec'
import { isConsistent } from './ledger/audit'
import { vacated } from './observe/facts'
import { invalidDeployment } from './ledger/invalid'
import { reusable } from './volume/reuse'
import { requireTransition } from './ledger/transitions'
import { requireIntact, reserve } from './handoff/stage'
import { deploymentSchema, type Deployment } from './types'
import { notFound, type DeploymentSelector } from './volume/alias'
import { userId } from '../host'
import { stateFailure } from '../errors'
import { encodeRecord } from '../../json'
import { accept } from '../primitives'
import { openAwsRoot, requireOperationLock } from '../root'
import { sameIdentity } from '../auth/identity'
import { requireStorageReleased } from './incus/facts'
import { requirePoolReleased } from './zfs/facts'
import { InstallerError } from '../../diagnostic/error'
import { openChildDir, readChild, writeChild, type Dir } from '../../state/files'
import { isErrorCode, isOperationId } from '../../guards'
import * as incus from './incus/records'
import * as zfs from './zfs/records'
import type { AwsIdentity } from '../types'

function ownership() {
  return {
    owner: userId(),
    mode: 0o700,
  }
}

export function parse(value: unknown): Deployment {
  const record = accept(deploymentSchema, value)
  if (record === null || !isConsistent(record)) {
    return invalidDeployment()
  }
  return record
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
    return invalidDeployment()
  }
  const store = await openStore(root, create)
  if (!store) {
    return null
  }
  return await optional(() => openChildDir(store, id, ownership(), create), create)
}

export async function directoryOf(root: Dir, id: string): Promise<Dir> {
  const directory = await openDirectory(root, id)
  return directory ?? invalidDeployment()
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
      return invalidDeployment()
    }
    return record
  } catch (error: unknown) {
    if (error instanceof InstallerError) {
      throw error
    }
    return invalidDeployment()
  }
}

async function write(directory: Dir, record: Deployment): Promise<void> {
  const bytes = encodeRecord(parse(record), 'AWS_DEPLOYMENT_STATE_INVALID', AWS_SPEC.limits.record)
  try {
    await writeChild(directory, AWS_SPEC.state.deployment, bytes, 0o600)
  } catch (error: unknown) {
    throw stateFailure(error)
  }
}

/**
 * The records of one alias form a chain through their explicit `previous`
 * links, never through timestamps. The newest is the one record that no other
 * record names as its predecessor. Anything but one unbroken chain with a
 * single root and a single tip fails closed.
 */
async function tipOf(root: Dir, alias: string): Promise<Deployment | null> {
  const chain = (await list(root)).filter(record => record.alias === alias)
  if (chain.length === 0) {
    return null
  }
  const ids = new Set(chain.map(record => record.id))
  const tips = chain.filter(record => !chain.some(other => other.previous === record.id))
  const roots = chain.filter(record => record.previous === null || !ids.has(record.previous))
  if (tips.length !== 1 || roots.length !== 1 || roots[0].previous !== null) {
    return invalidDeployment()
  }
  return tips[0]
}

/**
 * An alias can be taken over only when its newest deployment has verified
 * removal and nothing remains unresolved, has abandoned its reservation, or
 * never provisioned anything. Returns that deployment, or null when the alias
 * is unused. The authoritative check runs again inside `create` under the
 * operation lock.
 */
export async function predecessor(root: Dir, alias: string): Promise<Deployment | null> {
  const tip = await tipOf(root, alias)
  if (tip !== null && !vacated(tip)) {
    throw new InstallerError({
      code: 'AWS_DEPLOYMENT_ALIAS_TAKEN',
      facts: [['Alias', alias]],
      retry: 'qiln aws deployment list',
    })
  }
  return tip
}

/**
 * Refuses unless the hand-off of the predecessor's volume is not contradicted
 * by its replacement: the reservation and the replacement name each other, and
 * a replacement that holds the volume has its completion recorded. Reported
 * states, such as a reservation whose replacement has not started, pass.
 */
export async function requireFinalized(root: Dir, previous: Deployment): Promise<void> {
  const replacement = previous.successor === null ? null : await read(root, previous.successor.to)
  requireIntact(previous, replacement)
}

export async function create(root: Dir, record: Deployment): Promise<void> {
  await requireOperationLock(root)
  const initial = parse(record)
  if (
    initial.steps.length !== 0 ||
    initial.removals.length !== 0 ||
    initial.adminKey !== null ||
    initial.hostKey !== null ||
    initial.implicit !== null ||
    initial.latest !== null ||
    initial.health !== null ||
    initial.successor !== null ||
    initial.abandonment !== null ||
    initial.termination !== 'confirmed'
  ) {
    return invalidDeployment()
  }
  const previous = await predecessor(root, initial.alias)
  if ((previous?.id ?? null) !== initial.previous) {
    return invalidDeployment()
  }
  const { volume } = initial.approval.host
  if (volume.kind === 'reuse') {
    if (previous === null) {
      return invalidDeployment()
    }
    await requireFinalized(root, previous)
    if (reusable(previous)?.volumeId !== volume.volumeId) {
      return invalidDeployment()
    }
    const previousDirectory = await directoryOf(root, previous.id)
    requirePoolReleased(await zfs.read(previousDirectory, previous), previous.id)
    requireStorageReleased(await incus.read(previousDirectory, previous), previous.id)
  }
  const directory = await openDirectory(root, initial.id, true)
  if (!directory || (await directory.list()).length !== 0) {
    return invalidDeployment()
  }
  await write(directory, initial)
  // Only a reservation: the volume has not been attached to the replacement yet.
  if (volume.kind === 'reuse' && previous !== null) {
    await save(root, reserve(previous, initial.id))
  }
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

export async function find(root: Dir, selector: DeploymentSelector): Promise<Deployment | null> {
  if (selector.kind === 'id') {
    return await read(root, selector.value)
  }
  return await tipOf(root, selector.value)
}

/**
 * Like `find`, but a missing deployment is the operator-facing not-found
 * diagnostic, so every caller reports it the same way.
 */
export async function select(root: Dir, selector: DeploymentSelector): Promise<Deployment> {
  const record = await find(root, selector)
  if (record === null) {
    throw notFound(selector)
  }
  return record
}

/**
 * Lock-free and read-only, so a command can resolve a deployment while another
 * AWS operation runs. The root is returned for callers that read more evidence.
 */
export async function selectLocal(selector: DeploymentSelector): Promise<{ root: Dir; record: Deployment }> {
  const root = await openAwsRoot()
  if (root === null) {
    throw notFound(selector)
  }
  return { root, record: await select(root, selector) }
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
    return invalidDeployment()
  }
  requireTransition(await load(directory), next)
  await write(directory, next)
}

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

export async function bound(root: Dir, identity: AwsIdentity): Promise<Deployment[]> {
  return (await list(root)).filter(record => sameIdentity(record.binding.operator, identity))
}
