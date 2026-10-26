import { basename, join } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
import { INSTALLER_SPEC } from './spec'
import { isErrorCode } from '../guards'
import {
  Dir,
  FileValidationError,
  createDir,
  inspectChild,
  openChildDir,
  openDir,
  readChild,
  writeChild,
} from '../state/files'
import { InstallerError } from '../diagnostic/error'
import { acquireLock, requireLock, type LockOptions, type StateLock } from '../state/lock'
import { statePath } from '../state/path'
import { currentUserId } from '../state/user'
import {
  installationSchema,
  invalidRecord,
  newRecord,
  requireBound,
  requireHost,
  requireTransition,
  sameHost,
  type HostBinding,
  type InstallationRecord,
} from './records'
import type { Retry } from '../retry'
import type { InstallationInputs } from './types'

const MAX_RECORD_BYTES = 65_536
const FULL_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/
const FILES = INSTALLER_SPEC.state
const LOCK_CODES = {
  changed: 'INSTALLER_LOCK_CHANGED',
  locked: 'INSTALLER_LOCKED',
  failed: 'INSTALLER_LOCK_FAILED',
} as const

function installationLock(retry: string): LockOptions {
  return {
    name: FILES.lockFileName,
    label: 'installation',
    retry,
    codes: LOCK_CODES,
  }
}

/**
 * What earlier versions kept directly in the state directory. These entries
 * would be a second credential authority, so they are refused and never read,
 * copied, migrated, or deleted.
 */
const LEGACY_ENTRIES: readonly string[] = [
  FILES.installationFileName,
  FILES.legacyLockFileName,
  ...Object.values(INSTALLER_SPEC.credentials.files),
]

/**
 * The record once an image is pinned.
 */
export type InstallationState = InstallationRecord & { imageFingerprint: string }

export interface InstallationInspection {
  directoryPath: string
  exists: boolean
  record: InstallationRecord | null
}

/**
 * One registered installation as retained locally, without any host check.
 */
export interface InstalledEntry {
  name: string
  directory: Dir
  record: InstallationRecord
}

function ownership() {
  return {
    owner: currentUserId(),
    mode: 0o700,
  }
}

export function installerStatePath(retry: string, environment: NodeJS.ProcessEnv = process.env): string {
  return statePath(environment, retry)
}

function stateError(error: unknown, path: string, retry: string, expectedDirectory?: boolean): InstallerError {
  if (error instanceof InstallerError) {
    return error
  }
  if (error instanceof FileValidationError) {
    const expectsDirectory = expectedDirectory ?? error.entryType === 'directory'
    if (error.kind === 'type') {
      return new InstallerError({
        code: 'UNSAFE_STATE_ENTRY',
        facts: [
          [
            'Observed',
            expectedDirectory === undefined
              ? `${path} is not a supported regular file or real directory.`
              : `${path} is not a ${expectsDirectory ? 'real directory' : 'regular file'}.`,
          ],
        ],
        retry,
      })
    }
    if (error.kind === 'owner') {
      return new InstallerError({
        code: 'INVALID_STATE_OWNER',
        facts: [['Observed', `${path} does not have the expected UID ${currentUserId()} ownership.`]],
        retry,
      })
    }
    if (error.kind === 'mode') {
      const expectedMode = expectsDirectory ? '0700' : '0600'
      return new InstallerError({
        code: 'INVALID_STATE_MODE',
        facts: [['Observed', `${path} does not have the required ${expectedMode} mode.`]],
        retry,
      })
    }
    return new InstallerError({
      code: 'STATE_ACCESS_FAILED',
      facts: [['Observed', `${path} could not be read as one stable validated snapshot.`]],
      retry,
    })
  }
  if (isErrorCode(error, 'ELOOP') || isErrorCode(error, 'ENOTDIR')) {
    return new InstallerError({
      code: 'UNSAFE_STATE_ENTRY',
      facts: [['Observed', `${path} is not a supported non-symbolic-link directory or file.`]],
      retry,
    })
  }
  return new InstallerError({
    code: 'STATE_ACCESS_FAILED',
    facts: [['Observed', `The state path ${path} is not accessible.`]],
    retry,
  })
}

/**
 * Opens the directory that holds every named installation, refusing a state
 * directory that still holds the earlier root-level layout. Without `create`,
 * an absent directory is null.
 */
async function openRegistry(environment: NodeJS.ProcessEnv, create: boolean, retry: string): Promise<Dir | null> {
  const path = installerStatePath(retry, environment)
  let root: Dir
  try {
    root = await openDir(path, ownership())
  } catch (error: unknown) {
    if (!isErrorCode(error, 'ENOENT')) {
      throw stateError(error, path, retry, true)
    }
    if (!create) {
      return null
    }
    try {
      root = await createDir(path, ownership())
    } catch (creationError: unknown) {
      throw stateError(creationError, path, retry, true)
    }
  }
  let names: string[]
  try {
    names = await root.list()
  } catch (error: unknown) {
    throw stateError(error, path, retry, true)
  }
  const legacy = LEGACY_ENTRIES.filter(name => names.includes(name))
  if (legacy.length > 0) {
    throw new InstallerError({
      code: 'INSTALLER_LEGACY_STATE',
      facts: [['Observed', `${path} holds superseded entries: ${legacy.join(', ')}.`]],
      retry,
    })
  }
  try {
    return await openChildDir(root, FILES.directory, ownership(), create)
  } catch (error: unknown) {
    if (!create && isErrorCode(error, 'ENOENT')) {
      return null
    }
    throw stateError(error, root.child(FILES.directory), retry, true)
  }
}

async function openDirectory(parent: Dir, name: string, retry: string, create = false): Promise<Dir> {
  try {
    return await openChildDir(parent, name, ownership(), create)
  } catch (error: unknown) {
    throw stateError(error, join(parent.path, name), retry, true)
  }
}

async function inspectEntries(directory: Dir, retry: string): Promise<void> {
  for (const name of await directory.list()) {
    try {
      await inspectChild(directory, name, {
        owner: currentUserId(),
        fileMode: 0o600,
        directoryMode: 0o700,
      })
    } catch (error: unknown) {
      throw stateError(error, join(directory.path, name), retry)
    }
  }
}

function parseRecord(value: unknown, directory: Dir, retry: string): InstallationRecord {
  const parsed = installationSchema.safeParse(value)
  if (!parsed.success || parsed.data.name !== basename(directory.path)) {
    throw invalidRecord('installation.json does not match the installation record schema or its directory name.', retry)
  }
  return parsed.data
}

/**
 * Reads the record of one installation directory. An absent file is null.
 */
export async function readInstallation(directory: Dir, retry: string): Promise<InstallationRecord | null> {
  const path = join(directory.path, FILES.installationFileName)
  let bytes: Uint8Array
  try {
    const snapshot = await readChild(directory, FILES.installationFileName, {
      owner: currentUserId(),
      mode: 0o600,
      minSize: 1,
      maxSize: MAX_RECORD_BYTES,
    })
    bytes = snapshot.bytes
  } catch (error: unknown) {
    if (isErrorCode(error, 'ENOENT')) {
      return null
    }
    throw stateError(error, path, retry, false)
  }
  try {
    return parseRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown, directory, retry)
  } catch (error: unknown) {
    throw error instanceof InstallerError ? error : invalidRecord('installation.json could not be decoded.', retry)
  }
}

/**
 * Reads the record of a registered installation and requires it to match the
 * given binding. Call it under the installation lock, so the binding is checked
 * again after registration.
 */
export async function loadInstallation(
  directory: Dir,
  host: HostBinding,
  inputs: InstallationInputs,
  retry: string,
): Promise<InstallationRecord> {
  const record = await readInstallation(directory, retry)
  if (record === null) {
    throw invalidRecord('installation.json is absent from a registered installation.', retry)
  }
  requireBound(record, host, inputs, retry)
  return record
}

export function pinned(record: InstallationRecord | null): InstallationState | null {
  return record === null || record.imageFingerprint === null
    ? null
    : { ...record, imageFingerprint: record.imageFingerprint }
}

async function saveRecord(directory: Dir, record: InstallationRecord, retry: string): Promise<void> {
  const next = parseRecord(record, directory, retry)
  const current = await readInstallation(directory, retry)
  if (current !== null) {
    requireTransition(current, next, retry)
  }
  try {
    await writeChild(
      directory,
      FILES.installationFileName,
      new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`),
      0o600,
    )
  } catch (error: unknown) {
    throw stateError(error, join(directory.path, FILES.installationFileName), retry, false)
  }
}

/**
 * Persists the image pin of a bound record, under the installation lock.
 */
export async function pinImage(
  directory: Dir,
  record: InstallationRecord,
  imageFingerprint: string,
  retry: Retry,
): Promise<InstallationState> {
  if (!FULL_FINGERPRINT_PATTERN.test(imageFingerprint)) {
    throw new InstallerError({
      code: 'INVALID_IMAGE_FINGERPRINT',
      facts: [['Observed', 'The proposed installation state fingerprint is malformed.']],
      retry: retry.configureImage('<alias-or-fingerprint>'),
    })
  }
  const next = { ...record, imageFingerprint }
  await saveRecord(directory, next, retry.inspect)
  return next
}

async function register(
  registry: Dir,
  name: string,
  host: HostBinding,
  inputs: InstallationInputs,
  retry: string,
): Promise<Dir> {
  const entries = await registry.list()
  for (const other of entries.filter(entry => entry !== FILES.registryLockFileName && entry !== name)) {
    const record = await readInstallation(await openDirectory(registry, other, retry), retry)
    if (record !== null && sameHost(record.host, host)) {
      throw new InstallerError({
        code: 'INSTALLATION_HOST_REGISTERED',
        facts: [
          ['Registered installation', other],
          ['Requested installation', name],
        ],
        retry,
      })
    }
  }
  if (entries.includes(name)) {
    const directory = await openDirectory(registry, name, retry)
    await loadInstallation(directory, host, inputs, retry)
    return directory
  }
  const directory = await openDirectory(registry, name, retry, true)
  await saveRecord(directory, newRecord(name, host, inputs), retry)
  return directory
}

/**
 * Returns the directory of the named installation, creating and recording it
 * when it is new. Registration is serialized by a small registry lock, and an
 * existing installation must already match the binding. Nothing is migrated or
 * rebound.
 */
export async function registerInstallation(
  name: string,
  host: HostBinding,
  inputs: InstallationInputs,
  retry: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Dir> {
  const registry = await openRegistry(environment, true, retry)
  if (registry === null) {
    throw new InstallerError({
      code: 'INTERNAL_ERROR',
      retry,
    })
  }
  const lock = await acquireLock(registry, {
    name: FILES.registryLockFileName,
    label: 'installation registry',
    retry,
    codes: LOCK_CODES,
  })
  try {
    return await register(registry, name, host, inputs, retry)
  } finally {
    await lock.release()
  }
}

export function acquireInstallationLock(directory: Dir, retry: string): Promise<StateLock> {
  return acquireLock(directory, installationLock(retry))
}

/**
 * Confirms that the installation lock still names this process before any
 * installation evidence is written.
 */
export function requireInstallationLock(directory: Dir, retry: string): Promise<void> {
  return requireLock(directory, installationLock(retry))
}

/**
 * Read-only inspection that creates nothing. A record that exists must belong
 * to this host.
 */
export async function inspectInstallation(
  name: string,
  host: HostBinding,
  retry: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<InstallationInspection> {
  const registry = await openRegistry(environment, false, retry)
  const directoryPath = join(installerStatePath(retry, environment), FILES.directory, name)
  if (registry === null || !(await registry.list()).includes(name)) {
    return { directoryPath, exists: false, record: null }
  }
  const directory = await openDirectory(registry, name, retry)
  await inspectEntries(directory, retry)
  const record = await readInstallation(directory, retry)
  if (record !== null) {
    requireHost(record, host, retry)
  }
  return { directoryPath, exists: true, record }
}

/**
 * Lock-free listing of every registered installation, so it can run while
 * another operation holds a lock. It creates nothing and checks no host
 * binding, because it reports retained evidence only.
 */
export async function listInstallations(
  retry: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<InstalledEntry[]> {
  const registry = await openRegistry(environment, false, retry)
  if (registry === null) {
    return []
  }
  const entries: InstalledEntry[] = []
  for (const name of await registry.list()) {
    if (name === FILES.registryLockFileName) {
      continue
    }
    const directory = await openDirectory(registry, name, retry)
    const record = await readInstallation(directory, retry)
    if (record !== null) {
      entries.push({ name, directory, record })
    }
  }
  return entries
}
