import { basename, join } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
import { InstallerError } from '../diagnostic/error'
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
import { acquireLock, requireLock, type LockOptions, type StateLock } from '../state/lock'
import { statePath } from '../state/path'
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
import { INSTALLER_SPEC } from './spec'
import type { InstallationInputs } from './types'

const MAX_RECORD_BYTES = 65_536
const FULL_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/
const FILES = INSTALLER_SPEC.state
const LOCK_CODES = {
  changed: 'INSTALLER_LOCK_CHANGED',
  locked: 'INSTALLER_LOCKED',
  failed: 'INSTALLER_LOCK_FAILED',
} as const

const INSTALLATION_LOCK: LockOptions = {
  name: FILES.lockFileName,
  label: 'installation',
  retry: 'qiln doctor',
  codes: LOCK_CODES,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isErrorCode(value: unknown, code: string): boolean {
  return isRecord(value) && value.code === code
}

export function currentUserId(): number {
  if (typeof process.geteuid !== 'function') {
    throw new InstallerError({
      code: 'UNSUPPORTED_PLATFORM',
      facts: [['Observed', `Node platform '${process.platform}' does not expose process.geteuid().`]],
      retry: 'qiln doctor',
    })
  }
  return process.geteuid()
}

function ownership() {
  return {
    owner: currentUserId(),
    mode: 0o700,
  }
}

export function installerStatePath(environment: NodeJS.ProcessEnv = process.env): string {
  return statePath(environment)
}

function stateError(error: unknown, path: string, expectedDirectory?: boolean): InstallerError {
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
        retry: 'qiln doctor',
      })
    }
    if (error.kind === 'owner') {
      return new InstallerError({
        code: 'INVALID_STATE_OWNER',
        facts: [['Observed', `${path} does not have the expected UID ${currentUserId()} ownership.`]],
        retry: 'qiln doctor',
      })
    }
    if (error.kind === 'mode') {
      const expectedMode = expectsDirectory ? '0700' : '0600'
      return new InstallerError({
        code: 'INVALID_STATE_MODE',
        facts: [['Observed', `${path} does not have the required ${expectedMode} mode.`]],
        retry: 'qiln doctor',
      })
    }
    return new InstallerError({
      code: 'STATE_ACCESS_FAILED',
      facts: [['Observed', `${path} could not be read as one stable validated snapshot.`]],
      retry: 'qiln doctor',
    })
  }
  if (isErrorCode(error, 'ELOOP') || isErrorCode(error, 'ENOTDIR')) {
    return new InstallerError({
      code: 'UNSAFE_STATE_ENTRY',
      facts: [['Observed', `${path} is not a supported non-symbolic-link directory or file.`]],
      retry: 'qiln doctor',
    })
  }
  return new InstallerError({
    code: 'STATE_ACCESS_FAILED',
    facts: [['Observed', `The state path ${path} is not accessible.`]],
    retry: 'qiln doctor',
  })
}

/**
 * Opens the directory that holds every named installation, refusing a state
 * directory that still holds the earlier root-level layout. Without `create`,
 * an absent directory is null.
 */
async function openRegistry(environment: NodeJS.ProcessEnv, create: boolean): Promise<Dir | null> {
  const path = installerStatePath(environment)
  let root: Dir
  try {
    root = await openDir(path, ownership())
  } catch (error: unknown) {
    if (!isErrorCode(error, 'ENOENT')) {
      throw stateError(error, path, true)
    }
    if (!create) {
      return null
    }
    try {
      root = await createDir(path, ownership())
    } catch (creationError: unknown) {
      throw stateError(creationError, path, true)
    }
  }
  let names: string[]
  try {
    names = await root.list()
  } catch (error: unknown) {
    throw stateError(error, path, true)
  }
  const legacy = LEGACY_ENTRIES.filter(name => names.includes(name))
  if (legacy.length > 0) {
    throw new InstallerError({
      code: 'INSTALLER_LEGACY_STATE',
      facts: [['Observed', `${path} holds superseded entries: ${legacy.join(', ')}.`]],
      retry: 'qiln doctor',
    })
  }
  try {
    return await openChildDir(root, FILES.directory, ownership(), create)
  } catch (error: unknown) {
    if (!create && isErrorCode(error, 'ENOENT')) {
      return null
    }
    throw stateError(error, root.child(FILES.directory), true)
  }
}

async function openDirectory(parent: Dir, name: string, create = false): Promise<Dir> {
  try {
    return await openChildDir(parent, name, ownership(), create)
  } catch (error: unknown) {
    throw stateError(error, join(parent.path, name), true)
  }
}

async function inspectEntries(directory: Dir): Promise<void> {
  for (const name of await directory.list()) {
    try {
      await inspectChild(directory, name, {
        owner: currentUserId(),
        fileMode: 0o600,
        directoryMode: 0o700,
      })
    } catch (error: unknown) {
      throw stateError(error, join(directory.path, name))
    }
  }
}

function parseRecord(value: unknown, directory: Dir): InstallationRecord {
  const parsed = installationSchema.safeParse(value)
  if (!parsed.success || parsed.data.name !== basename(directory.path)) {
    throw invalidRecord('installation.json does not match the installation record schema or its directory name.')
  }
  return parsed.data
}

/**
 * Reads the record of one installation directory. An absent file is null.
 */
export async function readInstallation(directory: Dir): Promise<InstallationRecord | null> {
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
    throw stateError(error, path, false)
  }
  try {
    return parseRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown, directory)
  } catch (error: unknown) {
    throw error instanceof InstallerError ? error : invalidRecord('installation.json could not be decoded.')
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
): Promise<InstallationRecord> {
  const record = await readInstallation(directory)
  if (record === null) {
    throw invalidRecord('installation.json is absent from a registered installation.')
  }
  requireBound(record, host, inputs)
  return record
}

export function pinned(record: InstallationRecord | null): InstallationState | null {
  return record === null || record.imageFingerprint === null
    ? null
    : { ...record, imageFingerprint: record.imageFingerprint }
}

async function saveRecord(directory: Dir, record: InstallationRecord): Promise<void> {
  const next = parseRecord(record, directory)
  const current = await readInstallation(directory)
  if (current !== null) {
    requireTransition(current, next)
  }
  try {
    await writeChild(
      directory,
      FILES.installationFileName,
      new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`),
      0o600,
    )
  } catch (error: unknown) {
    throw stateError(error, join(directory.path, FILES.installationFileName), false)
  }
}

/**
 * Persists the image pin of a bound record, under the installation lock.
 */
export async function pinImage(
  directory: Dir,
  record: InstallationRecord,
  imageFingerprint: string,
): Promise<InstallationState> {
  if (!FULL_FINGERPRINT_PATTERN.test(imageFingerprint)) {
    throw new InstallerError({
      code: 'INVALID_IMAGE_FINGERPRINT',
      facts: [['Observed', 'The proposed installation state fingerprint is malformed.']],
      retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
    })
  }
  const next = { ...record, imageFingerprint }
  await saveRecord(directory, next)
  return next
}

async function register(
  registry: Dir,
  name: string,
  host: HostBinding,
  inputs: InstallationInputs,
): Promise<Dir> {
  const entries = await registry.list()
  for (const other of entries.filter(entry => entry !== FILES.registryLockFileName && entry !== name)) {
    const record = await readInstallation(await openDirectory(registry, other))
    if (record !== null && sameHost(record.host, host)) {
      throw new InstallerError({
        code: 'INSTALLATION_HOST_REGISTERED',
        facts: [
          ['Registered installation', other],
          ['Requested installation', name],
        ],
        retry: 'qiln doctor',
      })
    }
  }
  if (entries.includes(name)) {
    const directory = await openDirectory(registry, name)
    await loadInstallation(directory, host, inputs)
    return directory
  }
  const directory = await openDirectory(registry, name, true)
  await saveRecord(directory, newRecord(name, host, inputs))
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
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Dir> {
  const registry = await openRegistry(environment, true)
  if (registry === null) {
    throw new InstallerError({
      code: 'INTERNAL_ERROR',
      retry: 'qiln doctor',
    })
  }
  const lock = await acquireLock(registry, {
    name: FILES.registryLockFileName,
    label: 'installation registry',
    retry: 'qiln doctor',
    codes: LOCK_CODES,
  })
  try {
    return await register(registry, name, host, inputs)
  } finally {
    await lock.release()
  }
}

export function acquireInstallationLock(directory: Dir): Promise<StateLock> {
  return acquireLock(directory, INSTALLATION_LOCK)
}

/**
 * Confirms that the installation lock still names this process before any
 * installation evidence is written.
 */
export function requireInstallationLock(directory: Dir): Promise<void> {
  return requireLock(directory, INSTALLATION_LOCK)
}

/**
 * Read-only inspection that creates nothing. A record that exists must belong
 * to this host.
 */
export async function inspectInstallation(
  name: string,
  host: HostBinding,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<InstallationInspection> {
  const registry = await openRegistry(environment, false)
  const directoryPath = join(installerStatePath(environment), FILES.directory, name)
  if (registry === null || !(await registry.list()).includes(name)) {
    return { directoryPath, exists: false, record: null }
  }
  const directory = await openDirectory(registry, name)
  await inspectEntries(directory)
  const record = await readInstallation(directory)
  if (record !== null) {
    requireHost(record, host)
  }
  return { directoryPath, exists: true, record }
}
