import { basename, dirname, join, resolve } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
import { InstallerError } from '../diagnostic/error'
import { runProcess } from '../process'
import {
  Dir,
  FileValidationError,
  createDir,
  inspectChild,
  openDir,
  readChild,
  withTemp,
  writeChild,
  type FileSnapshot,
} from './files'
import { INSTALLER_SPEC } from './spec'

const MAX_INSTALLATION_STATE_BYTES = 65_536
const MAX_AUTHORIZED_KEYS_BYTES = 1_048_576
const FULL_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/
const PUBLIC_KEY_BLOB_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/
const SUPPORTED_AUTHORIZED_KEY_ALGORITHMS = new Set([
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
])

export interface InstallationState {
  version: 1
  projectName: string
  instanceName: string
  imageFingerprint: string
}

export interface InstallerStateInspection {
  directoryPath: string
  exists: boolean
  installation: InstallationState | null
  roster: FileSnapshot | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isErrorCode(value: unknown, code: string): boolean {
  return isRecord(value) && value.code === code
}

function currentUserId(): number {
  if (typeof process.geteuid !== 'function') {
    throw new InstallerError({
      code: 'UNSUPPORTED_PLATFORM',
      facts: [['Observed', `Node platform '${process.platform}' does not expose process.geteuid().`]],
      retry: 'qiln doctor',
    })
  }
  return process.geteuid()
}

export function installerStatePath(environment: NodeJS.ProcessEnv = process.env): string {
  const configuredStateHome = environment.XDG_STATE_HOME?.trim()
  if (configuredStateHome) {
    if (!configuredStateHome.startsWith('/')) {
      throw new InstallerError({
        code: 'INVALID_STATE_HOME',
        facts: [['Observed', 'XDG_STATE_HOME is set to a relative path.']],
        retry: 'qiln doctor',
      })
    }
    return resolve(configuredStateHome, 'qiln')
  }
  const home = environment.HOME?.trim()
  if (!home || !home.startsWith('/')) {
    throw new InstallerError({
      code: 'MISSING_HOME',
      facts: [['Observed', 'HOME is missing, empty, or relative.']],
      retry: 'qiln doctor',
    })
  }
  return resolve(home, '.local/state/qiln')
}

function stateError(error: unknown, path: string, expectedDirectory?: boolean): InstallerError {
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

function parseInstallationState(value: unknown): InstallationState {
  if (
    !isRecord(value) ||
    value.version !== INSTALLER_SPEC.stateVersion ||
    value.projectName !== INSTALLER_SPEC.projectName ||
    value.instanceName !== INSTALLER_SPEC.orchestrator.name ||
    typeof value.imageFingerprint !== 'string' ||
    !FULL_FINGERPRINT_PATTERN.test(value.imageFingerprint)
  ) {
    throw new InstallerError({
      code: 'INVALID_INSTALLATION_STATE',
      facts: [
        [
          'Observed',
          'installation.json does not contain the expected version, project, instance, and full lowercase image fingerprint.',
        ],
      ],
      retry: 'qiln doctor',
    })
  }
  const expectedKeys = ['imageFingerprint', 'instanceName', 'projectName', 'version']
  const actualKeys = Object.keys(value).sort()
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new InstallerError({
      code: 'INVALID_INSTALLATION_STATE',
      facts: [['Observed', 'installation.json does not match the installer state schema.']],
      retry: 'qiln doctor',
    })
  }
  return {
    version: 1,
    projectName: value.projectName,
    instanceName: value.instanceName,
    imageFingerprint: value.imageFingerprint,
  }
}

function readInstallationState(snapshot: FileSnapshot): InstallationState {
  let parsed: unknown
  try {
    const content = new TextDecoder('utf-8', {
      fatal: true,
    }).decode(snapshot.bytes)
    parsed = JSON.parse(content) as unknown
  } catch {
    throw new InstallerError({
      code: 'INVALID_INSTALLATION_STATE',
      facts: [['Observed', 'installation.json could not be decoded.']],
      retry: 'qiln doctor',
    })
  }
  return parseInstallationState(parsed)
}

async function readStateChild(directory: Dir, name: string, maxSize: number): Promise<FileSnapshot> {
  try {
    return await readChild(directory, name, {
      owner: currentUserId(),
      mode: 0o600,
      maxSize,
    })
  } catch (error: unknown) {
    throw stateError(error, join(directory.path, name), false)
  }
}

function rosterReadError(error: unknown, path: string): InstallerError {
  if (isErrorCode(error, 'ENOENT')) {
    return new InstallerError({
      code: 'AUTHORIZED_KEYS_NOT_FOUND',
      facts: [['Observed', `No readable roster was found at ${path}.`]],
      retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
    })
  }
  if (error instanceof FileValidationError && error.kind === 'owner') {
    return new InstallerError({
      code: 'INVALID_AUTHORIZED_KEYS_OWNER',
      facts: [['Observed', `${path} does not have the expected UID ${currentUserId()} ownership.`]],
      retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
    })
  }
  return new InstallerError({
    code: 'INVALID_AUTHORIZED_KEYS_FILE',
    facts: [['Observed', `${path} could not be opened as a stable bounded regular file.`]],
    retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
  })
}

async function inspectOpenState(directory: Dir): Promise<InstallerStateInspection> {
  let installationSnapshot: FileSnapshot | null = null
  let roster: FileSnapshot | null = null
  for (const name of await directory.list()) {
    if (name === INSTALLER_SPEC.state.installationFileName) {
      installationSnapshot = await readStateChild(directory, name, MAX_INSTALLATION_STATE_BYTES)
      continue
    }
    if (name === INSTALLER_SPEC.state.authorizedKeysFileName) {
      roster = await readStateChild(directory, name, MAX_AUTHORIZED_KEYS_BYTES)
      continue
    }
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
  return {
    directoryPath: directory.path,
    exists: true,
    installation: installationSnapshot === null ? null : readInstallationState(installationSnapshot),
    roster,
  }
}

export async function inspectInstallerState(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<InstallerStateInspection> {
  const directoryPath = installerStatePath(environment)
  let directory: Dir
  try {
    directory = await openDir(directoryPath, {
      owner: currentUserId(),
      mode: 0o700,
    })
  } catch (error: unknown) {
    if (isErrorCode(error, 'ENOENT')) {
      return {
        directoryPath,
        exists: false,
        installation: null,
        roster: null,
      }
    }
    throw stateError(error, directoryPath, true)
  }
  try {
    return await inspectOpenState(directory)
  } finally {
    await directory.close()
  }
}

export async function openInstallerState(environment: NodeJS.ProcessEnv = process.env): Promise<Dir> {
  const directoryPath = installerStatePath(environment)
  try {
    return await openDir(directoryPath, {
      owner: currentUserId(),
      mode: 0o700,
    })
  } catch (error: unknown) {
    if (!isErrorCode(error, 'ENOENT')) {
      throw stateError(error, directoryPath, true)
    }
  }
  try {
    return await createDir(directoryPath, {
      owner: currentUserId(),
      mode: 0o700,
    })
  } catch (error: unknown) {
    throw stateError(error, directoryPath, true)
  }
}

export async function inspectOpenInstallerState(directory: Dir): Promise<InstallerStateInspection> {
  try {
    return await inspectOpenState(directory)
  } catch (error: unknown) {
    if (error instanceof InstallerError) {
      throw error
    }
    throw stateError(error, directory.path, true)
  }
}

export async function writeInstallationState(directory: Dir, imageFingerprint: string): Promise<InstallationState> {
  if (!FULL_FINGERPRINT_PATTERN.test(imageFingerprint)) {
    throw new InstallerError({
      code: 'INVALID_IMAGE_FINGERPRINT',
      facts: [['Observed', 'The proposed installation state fingerprint is malformed.']],
      retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
    })
  }
  const state: InstallationState = {
    version: 1,
    projectName: INSTALLER_SPEC.projectName,
    instanceName: INSTALLER_SPEC.orchestrator.name,
    imageFingerprint,
  }
  const content = `${JSON.stringify(state, null, 2)}\n`
  await writeChild(directory, INSTALLER_SPEC.state.installationFileName, new TextEncoder().encode(content), 0o600)
  return state
}

/**
 * Reads one developer-managed authorized-key roster into a stable validated
 * snapshot without reopening its path for later content validation.
 */
export async function readRoster(rosterPath: string): Promise<FileSnapshot> {
  const path = resolve(rosterPath)
  let directory: Dir
  try {
    directory = await openDir(dirname(path))
  } catch (error: unknown) {
    throw rosterReadError(error, path)
  }
  try {
    return await readChild(directory, basename(path), {
      owner: currentUserId(),
      minSize: 1,
      maxSize: MAX_AUTHORIZED_KEYS_BYTES,
    })
  } catch (error: unknown) {
    throw rosterReadError(error, path)
  } finally {
    await directory.close().catch(() => undefined)
  }
}

/**
 * Validates the supplied in-memory roster snapshot and runs ssh-keygen only
 * against a temporary file containing those exact validated bytes.
 */
export async function validateRoster(roster: FileSnapshot, sshKeygenExecutable: string): Promise<FileSnapshot> {
  let content: string
  try {
    content = new TextDecoder('utf-8', {
      fatal: true,
    }).decode(roster.bytes)
  } catch (error: unknown) {
    throw new InstallerError({
      code: 'INVALID_AUTHORIZED_KEYS_CONTENT',
      facts: [['Observed', 'The validated roster snapshot could not be decoded as UTF-8.']],
      retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  let publicKeyCount = 0
  for (const [index, line] of content.split('\n').entries()) {
    if (line.includes('\r') || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(line)) {
      throw new InstallerError({
        code: 'INVALID_AUTHORIZED_KEYS_CONTENT',
        facts: [['Observed', `Unsupported content was found at line ${index + 1}.`]],
        retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
      })
    }
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue
    }
    const fields = trimmed.split(/\s+/)
    const algorithm = fields[0]
    const encodedKey = fields[1]
    if (
      fields.length < 2 ||
      algorithm === undefined ||
      encodedKey === undefined ||
      !SUPPORTED_AUTHORIZED_KEY_ALGORITHMS.has(algorithm) ||
      !PUBLIC_KEY_BLOB_PATTERN.test(encodedKey)
    ) {
      throw new InstallerError({
        code: 'INVALID_AUTHORIZED_KEYS_CONTENT',
        facts: [['Observed', `Line ${index + 1} is not a normal supported OpenSSH public-key line.`]],
        retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
      })
    }
    const decoded = Buffer.from(encodedKey, 'base64')
    if (decoded.length === 0 || decoded.toString('base64') !== encodedKey) {
      throw new InstallerError({
        code: 'INVALID_AUTHORIZED_KEYS_CONTENT',
        facts: [['Observed', `Line ${index + 1} does not contain canonical Base64 public-key data.`]],
        retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
      })
    }
    publicKeyCount++
  }
  if (publicKeyCount === 0) {
    throw new InstallerError({
      code: 'EMPTY_AUTHORIZED_KEYS_ROSTER',
      facts: [['Observed', 'The selected roster snapshot contains only blank lines or comments.']],
      retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  const validation = await withTemp(roster, path => runProcess(sshKeygenExecutable, ['-l', '-f', path]))
  if (validation.exitCode !== 0 || validation.stdout.trim() === '') {
    throw new InstallerError({
      code: 'INVALID_AUTHORIZED_KEYS_ROSTER',
      facts: [['Observed', 'The validated roster snapshot failed ssh-keygen public-key inspection.']],
      retry: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  return roster
}
