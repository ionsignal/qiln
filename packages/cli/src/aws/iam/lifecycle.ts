import { randomUUID } from 'node:crypto'
import { rm, unlink } from 'node:fs/promises'
import { basename } from 'node:path'
import { InstallerError } from '../../diagnostic/error'
import { openChildDir, type Dir } from '../../state/files'
import { sameIdentity } from '../auth/identity'
import { removeAuth } from '../auth/session'
import * as connections from '../connection/records'
import type { PolicyIdentity } from '../foundation/policy'
import { userId } from '../host'
import { sameJson } from '../json'
import { AWS_SPEC } from '../spec'
import type { AwsConnection } from '../types'
import { read, requireLock, write } from './journal'
import type { Pending } from './types'

function invalid(): never {
  throw new InstallerError({
    code: 'AWS_PERMISSION_STATE_INVALID',
  })
}

async function begin(directory: Dir, name: string, region: string, saved: AwsConnection | null): Promise<Pending> {
  await requireLock(directory)
  await connections.inspect(directory)
  if (
    basename(directory.path) !== name ||
    (await read(directory)) !== null ||
    (await directory.list()).includes(AWS_SPEC.state.root)
  ) {
    return invalid()
  }
  const current = await connections.read(directory, name)
  if (!sameJson(current, saved)) {
    return invalid()
  }
  if (saved === null && (await directory.list()).length !== 0) {
    throw new InstallerError({
      code: 'AWS_BOOTSTRAP_CONFLICT',
    })
  }
  if (saved !== null && saved.managed === null) {
    return invalid()
  }
  const id = randomUUID()
  const record: Pending = {
    version: 1,
    id,
    name,
    kind: saved === null ? 'onboard' : 'maintain',
    region,
    accountId: saved?.identity.accountId ?? null,
    creationId: saved?.managed?.creationId ?? id,
    operator: saved === null ? null : { ...saved.identity },
    foundation: null,
    approval: null,
    mutation: null,
    password: null,
    verified: null,
    termination: 'confirmed',
    cleanup: 'pending',
    failureCode: null,
    startedAt: new Date().toISOString(),
  }
  await write(directory, record)
  return record
}

export async function onboard(directory: Dir, name: string, region: string): Promise<Pending> {
  return await begin(directory, name, region, null)
}

export async function maintain(directory: Dir, saved: AwsConnection): Promise<Pending> {
  if (!saved.managed) {
    return invalid()
  }
  return await begin(directory, saved.name, saved.managed.permissionRegion, saved)
}

export async function cleanRoot(directory: Dir, operationId: string): Promise<void> {
  await requireLock(directory)
  const record = await read(directory)
  if (!record || record.id !== operationId || record.termination !== 'confirmed') {
    return invalid()
  }
  if (!(await directory.list()).includes(AWS_SPEC.state.root)) {
    await directory.sync()
    return
  }
  const root = await openChildDir(directory, AWS_SPEC.state.root, {
    owner: userId(),
    mode: 0o700,
  })
  if ((await root.list()).some(name => name !== AWS_SPEC.state.auth)) {
    return invalid()
  }
  await removeAuth(root)
  if ((await root.list()).length !== 0) {
    return invalid()
  }
  await rm(root.path, {
    recursive: true,
  })
  await directory.sync()
  if ((await directory.list()).includes(AWS_SPEC.state.root)) {
    throw new InstallerError({
      code: 'AWS_CLEANUP_FAILED',
    })
  }
}

function policyBinding(policy: PolicyIdentity) {
  return {
    arn: policy.arn,
    id: policy.id,
  }
}

export async function publish(directory: Dir, record: Pending): Promise<AwsConnection> {
  await requireLock(directory)
  const actual = await read(directory)
  if (
    !actual ||
    !sameJson(actual, record) ||
    !record.operator ||
    !record.foundation ||
    !record.verified ||
    record.failureCode !== null ||
    record.termination !== 'confirmed' ||
    record.cleanup !== 'completed' ||
    (await directory.list()).includes(AWS_SPEC.state.root)
  ) {
    return invalid()
  }
  const saved = await connections.read(directory, record.name)
  if (
    record.kind === 'maintain' &&
    (!saved ||
      !sameIdentity(saved.identity, record.operator) ||
      saved.managed?.creationId !== record.creationId ||
      saved.managed.permissionRegion !== record.region)
  ) {
    return invalid()
  }
  const connection: AwsConnection = {
    version: 2,
    name: record.name,
    region: saved?.region ?? record.region,
    identity: { ...record.operator },
    createdAt: saved?.createdAt ?? record.startedAt,
    managed: {
      creationId: record.creationId,
      permissionRegion: record.region,
      foundation: policyBinding(record.foundation),
      verified: { ...record.verified },
    },
  }
  await connections.save(directory, connection)
  const persisted = await connections.read(directory, record.name)
  if (!sameJson(persisted, connection)) {
    return invalid()
  }
  return connection
}

export async function removePending(directory: Dir, record: Pending): Promise<void> {
  await requireLock(directory)
  const actual = await read(directory)
  if (
    !actual ||
    !sameJson(actual, record) ||
    record.termination !== 'confirmed' ||
    record.cleanup !== 'completed' ||
    (await directory.list()).includes(AWS_SPEC.state.root)
  ) {
    return invalid()
  }
  if (record.approval !== null) {
    const saved = await connections.read(directory, record.name)
    if (
      record.failureCode !== null ||
      !record.verified ||
      !record.operator ||
      !record.foundation ||
      !saved ||
      !sameIdentity(saved.identity, record.operator) ||
      saved.managed?.creationId !== record.creationId ||
      saved.managed.permissionRegion !== record.region ||
      !sameJson(saved.managed.foundation, policyBinding(record.foundation)) ||
      !sameJson(saved.managed.verified, record.verified)
    ) {
      return invalid()
    }
  } else if (record.mutation !== null || record.password !== null || record.foundation !== null) {
    return invalid()
  }
  await unlink(directory.child(AWS_SPEC.state.pending))
  await directory.sync()
  if ((await directory.list()).includes(AWS_SPEC.state.pending)) {
    throw new InstallerError({
      code: 'AWS_CLEANUP_FAILED',
    })
  }
}
