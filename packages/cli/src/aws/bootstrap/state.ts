import { randomUUID } from 'node:crypto'
import { basename, dirname } from 'node:path'
import { InstallerError } from '../../diagnostic/error'
import { inspectChild, openChildDir, openDir, readChild, writeChild, type Dir } from '../../state/files'
import { sameIdentity } from '../auth/identity'
import { Session } from '../auth/session'
import { AWS_SPEC } from '../spec'
import { userId } from '../state'
import type { AwsConnection } from '../types'
import { arn, name } from './policy'
import { isBootstrapRecord, type BootstrapRecord } from './types'

function invalid(): never {
  throw new InstallerError({
    code: 'AWS_BOOTSTRAP_STATE_INVALID',
  })
}

export function parse(value: unknown): BootstrapRecord {
  if (!isBootstrapRecord(value)) {
    return invalid()
  }
  return value
}

export function copy(record: BootstrapRecord): BootstrapRecord {
  return parse(JSON.parse(JSON.stringify(record)) as unknown)
}

async function readRecord(directory: Dir): Promise<BootstrapRecord> {
  try {
    const snapshot = await readChild(directory, AWS_SPEC.bootstrap.record, {
      owner: userId(),
      mode: 0o600,
      minSize: 1,
      maxSize: AWS_SPEC.limits.record,
    })
    return parse(
      JSON.parse(
        new TextDecoder('utf-8', {
          fatal: true,
        }).decode(snapshot.bytes),
      ) as unknown,
    )
  } catch (error: unknown) {
    if (error instanceof InstallerError) {
      throw error
    }
    return invalid()
  }
}

/**
 * Bootstrap coordination requires the connection lock owned by this parent
 * process. Credential children read the journal but never write it.
 */
export async function requireLock(connection: Dir): Promise<void> {
  const storePath = dirname(connection.path)
  if (basename(storePath) !== AWS_SPEC.state.connections) {
    return invalid()
  }
  const aws = await openDir(dirname(storePath), {
    owner: userId(),
    mode: 0o700,
  })
  const snapshot = await readChild(aws, AWS_SPEC.state.lock, {
    owner: userId(),
    mode: 0o600,
    minSize: 1,
    maxSize: 64,
  })
  if (Buffer.from(snapshot.bytes).toString('utf8') !== `${process.pid}\n`) {
    throw new InstallerError({
      code: 'AWS_LOCK_CHANGED',
    })
  }
}

export async function create(connection: Dir, name: string, region: string): Promise<Dir> {
  await requireLock(connection)
  if (basename(connection.path) !== name || (await connection.list()).length !== 0) {
    throw new InstallerError({
      code: 'AWS_BOOTSTRAP_RECORDED',
    })
  }
  const now = new Date().toISOString()
  const record: BootstrapRecord = {
    version: 1,
    id: randomUUID(),
    name,
    region,
    phase: 'login',
    root: null,
    review: null,
    operator: null,
    readiness: null,
    approvedAt: null,
    startedAt: now,
    updatedAt: now,
    failureCode: null,
    termination: 'confirmed',
    cleanup: 'pending',
  }
  parse(record)
  const directory = await openChildDir(
    connection,
    AWS_SPEC.state.bootstrap,
    {
      owner: userId(),
      mode: 0o700,
    },
    true,
  )
  if ((await directory.list()).length !== 0) {
    return invalid()
  }
  await writeChild(directory, AWS_SPEC.bootstrap.record, Buffer.from(`${JSON.stringify(record, null, 2)}\n`), 0o600)
  return directory
}

export async function inspect(directory: Dir): Promise<BootstrapRecord> {
  const names = await directory.list()
  if (
    !names.includes(AWS_SPEC.bootstrap.record) ||
    names.some(name => name !== AWS_SPEC.bootstrap.record && name !== AWS_SPEC.state.auth)
  ) {
    return invalid()
  }
  const record = await readRecord(directory)
  if (basename(dirname(directory.path)) !== record.name) {
    return invalid()
  }
  if (names.includes(AWS_SPEC.state.auth)) {
    if (record.cleanup === 'completed') {
      return invalid()
    }
    await Session.open(directory, record.region)
  }
  return record
}

export async function read(connection: Dir): Promise<BootstrapRecord | null> {
  if (!(await connection.list()).includes(AWS_SPEC.state.bootstrap)) {
    return null
  }
  const directory = await openChildDir(connection, AWS_SPEC.state.bootstrap, {
    owner: userId(),
    mode: 0o700,
  })
  return await inspect(directory)
}

export async function save(directory: Dir, record: BootstrapRecord): Promise<void> {
  const connection = await openDir(dirname(directory.path), {
    owner: userId(),
    mode: 0o700,
  })
  await requireLock(connection)
  const current = await readRecord(directory)
  const validated = parse(record)
  if (
    current.id !== validated.id ||
    current.name !== validated.name ||
    current.region !== validated.region ||
    current.startedAt !== validated.startedAt
  ) {
    return invalid()
  }
  await writeChild(directory, AWS_SPEC.bootstrap.record, Buffer.from(`${JSON.stringify(validated, null, 2)}\n`), 0o600)
}

/**
 * A private child may operate only in the separate bootstrap authentication
 * subtree. Ordinary operator authentication cannot satisfy this boundary.
 */
export async function context(): Promise<{ directory: Dir; record: BootstrapRecord }> {
  const home = process.env.HOME
  if (!home || basename(home) !== AWS_SPEC.state.auth || basename(dirname(home)) !== AWS_SPEC.state.bootstrap) {
    return invalid()
  }
  const directory = await openDir(dirname(home), {
    owner: userId(),
    mode: 0o700,
  })
  const record = await inspect(directory)
  const kind = await inspectChild(directory, AWS_SPEC.state.auth, {
    owner: userId(),
    directoryMode: 0o700,
  })
  if (kind !== 'directory') {
    return invalid()
  }
  return {
    directory,
    record,
  }
}

export function facts(record: BootstrapRecord) {
  return [
    ['Bootstrap operation', record.id],
    ['Recorded phase', record.phase],
    ['Account', record.root?.identity.accountId ?? 'not verified'],
    ['Intended user', name(record.name)],
    ['Intended operator', record.root ? arn(record.root.identity.accountId, record.name) : 'account not verified'],
    ['Operator', record.operator?.arn ?? 'creation not verified'],
    ['Operator user ID', record.operator?.userId ?? 'not recorded'],
    ['Bootstrap termination', record.termination],
    ['Root context cleanup', record.cleanup],
    ['Recorded failure', record.failureCode ?? 'none'],
    ...(record.phase === 'password'
      ? ([
          [
            'Password',
            'Login-profile creation or terminal delivery may have completed. No password recovery or reissuance was attempted.',
          ],
        ] as const)
      : []),
    ['IAM recovery', 'No IAM rollback, deletion, adoption, or password reissuance was attempted.'],
  ] as const
}

/**
 * A completed journal permits ordinary authentication, not another IAM
 * bootstrap. Its original operator binding survives reconnects.
 */
export async function requireConnection(connection: Dir, saved: AwsConnection | null): Promise<void> {
  const record = await read(connection)
  if (!record) {
    return
  }
  if (
    record.phase !== 'saved' ||
    record.failureCode !== null ||
    record.termination !== 'confirmed' ||
    record.cleanup !== 'completed'
  ) {
    throw new InstallerError({
      code: 'AWS_BOOTSTRAP_RECORDED',
      facts: facts(record),
      retry: `qiln aws disconnect --name ${record.name}`,
    })
  }
  if (
    !saved ||
    !record.operator ||
    saved.name !== record.name ||
    saved.region !== record.region ||
    !sameIdentity(saved.identity, record.operator)
  ) {
    throw new InstallerError({
      code: 'AWS_BOOTSTRAP_STATE_INVALID',
      facts: [
        ...facts(record),
        ['Connection record', 'The completed bootstrap and saved connection do not have the same operator binding.'],
      ],
      retry: 'qiln aws --help',
    })
  }
}
