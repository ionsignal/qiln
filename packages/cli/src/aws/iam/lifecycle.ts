import { randomUUID } from 'node:crypto'
import { rm, unlink } from 'node:fs/promises'
import { basename } from 'node:path'
import { InstallerError } from '../../diagnostic/error'
import { openChildDir, type Dir } from '../../state/files'
import { sameIdentity } from '../auth/identity'
import { removeAuth } from '../auth/session'
import { userId } from '../host'
import { sameJson } from '../json'
import { read, requireLock, write } from './journal'
import { AWS_RECORD_VERSION, AWS_SPEC } from '../spec'
import { POLICY_KEYS, bindingEntries, policyMap, type PolicyBindings, type PolicyMap } from '../permission/keys'
import * as connections from '../connection/records'
import type { Pending } from './types'
import type { AwsConnection, PolicyBinding } from '../types'
import type { PolicyIdentity } from '../permission/policy'

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
    id,
    name,
    region,
    version: AWS_RECORD_VERSION.pending,
    kind: saved === null ? 'onboard' : 'maintain',
    accountId: saved?.identity.accountId ?? null,
    creationId: saved?.managed?.creationId ?? id,
    operator: saved === null ? null : { ...saved.identity },
    policies: policyMap(() => null),
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
  return await begin(directory, saved.name, saved.managed.deploymentRegion, saved)
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

function bindings(policies: PolicyMap<PolicyIdentity | null>): PolicyMap<PolicyBinding> {
  return policyMap(key => {
    const policy = policies[key]
    return policy === null ? invalid() : { arn: policy.arn, id: policy.id }
  })
}

function keepsBindings(saved: PolicyBindings<PolicyBinding>, retained: PolicyMap<PolicyIdentity | null>): boolean {
  return bindingEntries(saved).every(([key, policy]) => {
    const identity = retained[key]
    return identity !== null && identity.arn === policy.arn && identity.id === policy.id
  })
}

export async function publish(directory: Dir, record: Pending): Promise<AwsConnection> {
  await requireLock(directory)
  const actual = await read(directory)
  if (
    !actual ||
    !sameJson(actual, record) ||
    !record.operator ||
    !record.verified ||
    POLICY_KEYS.some(key => record.policies[key] === null) ||
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
      saved.managed.deploymentRegion !== record.region ||
      !keepsBindings(saved.managed.policies, record.policies))
  ) {
    return invalid()
  }
  const connection: AwsConnection = {
    version: AWS_RECORD_VERSION.connection,
    name: record.name,
    region: saved?.region ?? record.region,
    identity: { ...record.operator },
    createdAt: saved?.createdAt ?? record.startedAt,
    managed: {
      creationId: record.creationId,
      deploymentRegion: record.region,
      policies: bindings(record.policies),
      verified: structuredClone(record.verified),
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
      !saved ||
      !sameIdentity(saved.identity, record.operator) ||
      saved.managed?.creationId !== record.creationId ||
      saved.managed.deploymentRegion !== record.region ||
      !sameJson(saved.managed.policies, bindings(record.policies)) ||
      !sameJson(saved.managed.verified, record.verified)
    ) {
      return invalid()
    }
  } else if (
    record.mutation !== null ||
    record.password !== null ||
    POLICY_KEYS.some(key => record.policies[key] !== null)
  ) {
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
