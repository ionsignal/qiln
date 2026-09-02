import { basename, dirname, join, resolve } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
import { QilnInstallerError } from '../error'
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
    throw new QilnInstallerError({
      code: 'UNSUPPORTED_PLATFORM',
      check: 'installer state ownership',
      summary: 'The current platform cannot report the invoking effective user ID.',
      observed: `Node platform '${process.platform}' does not expose process.geteuid().`,
      reason: 'Qiln must prove that installer state belongs to the unprivileged invoking developer.',
      operatorAction: 'Run Qiln on the supported Ubuntu host as the invoking developer.',
      rerun: 'qiln doctor',
    })
  }
  return process.geteuid()
}

export function installerStatePath(environment: NodeJS.ProcessEnv = process.env): string {
  const configuredStateHome = environment.XDG_STATE_HOME?.trim()
  if (configuredStateHome) {
    if (!configuredStateHome.startsWith('/')) {
      throw new QilnInstallerError({
        code: 'INVALID_STATE_HOME',
        check: 'installer state path',
        summary: 'XDG_STATE_HOME must be an absolute path.',
        observed: 'XDG_STATE_HOME is set to a relative path.',
        reason: 'A relative state path could resolve differently between installer operations.',
        operatorAction: 'Unset XDG_STATE_HOME or set it to an absolute developer-owned directory.',
        rerun: 'qiln doctor',
      })
    }
    return resolve(configuredStateHome, 'qiln')
  }
  const home = environment.HOME?.trim()
  if (!home || !home.startsWith('/')) {
    throw new QilnInstallerError({
      code: 'MISSING_HOME',
      check: 'installer state path',
      summary: 'The invoking developer has no usable absolute HOME directory.',
      observed: 'HOME is missing, empty, or relative.',
      reason: 'Qiln cannot determine its default developer-owned installer state directory.',
      operatorAction: 'Run Qiln from a normal developer login with an absolute HOME directory.',
      rerun: 'qiln doctor',
    })
  }
  return resolve(home, '.local/state/qiln')
}

function stateError(error: unknown, path: string, expectedDirectory?: boolean): QilnInstallerError {
  if (error instanceof FileValidationError) {
    const expectsDirectory = expectedDirectory ?? error.entryType === 'directory'
    if (error.kind === 'type') {
      return new QilnInstallerError({
        code: 'UNSAFE_STATE_ENTRY',
        check: 'installer state safety',
        summary: 'The Qiln installer state contains an unsafe entry.',
        observed:
          expectedDirectory === undefined
            ? `${path} is not a supported regular file or real directory.`
            : `${path} is not a ${expectsDirectory ? 'real directory' : 'regular file'}.`,
        reason:
          'Symbolic links and special files could redirect installer state or credential access outside the protected state directory.',
        operatorAction:
          'Move the existing entry aside, inspect it manually, and restore only a developer-owned regular file or directory.',
        rerun: 'qiln doctor',
      })
    }
    if (error.kind === 'owner') {
      return new QilnInstallerError({
        code: 'INVALID_STATE_OWNER',
        check: 'installer state ownership',
        summary: 'The Qiln installer state is not owned by the invoking developer.',
        observed: `${path} does not have the expected UID ${currentUserId()} ownership.`,
        reason: 'Qiln must not read or later overwrite installer state owned by another identity.',
        operatorAction: 'Inspect the state path and correct its ownership manually before rerunning Qiln.',
        rerun: 'qiln doctor',
      })
    }
    if (error.kind === 'mode') {
      const expectedMode = expectsDirectory ? '0700' : '0600'
      return new QilnInstallerError({
        code: 'INVALID_STATE_MODE',
        check: 'installer state permissions',
        summary: 'The Qiln installer state permissions are not restrictive enough.',
        observed: `${path} does not have the required ${expectedMode} mode.`,
        reason: 'Installer state will contain local development credentials in later milestones.',
        operatorAction: `Review the path and manually set its mode to ${expectedMode}.`,
        rerun: 'qiln doctor',
      })
    }
    return new QilnInstallerError({
      code: 'STATE_ACCESS_FAILED',
      check: 'installer state access',
      summary: 'The Qiln installer state changed while it was being inspected.',
      observed: `${path} could not be read as one stable validated snapshot.`,
      reason: 'Qiln cannot safely use state or credential data that changed during validation.',
      operatorAction: 'Inspect the state path and retry once no other process is modifying it.',
      rerun: 'qiln doctor',
      cause: error,
    })
  }
  if (isErrorCode(error, 'ELOOP') || isErrorCode(error, 'ENOTDIR')) {
    return new QilnInstallerError({
      code: 'UNSAFE_STATE_ENTRY',
      check: 'installer state safety',
      summary: 'The Qiln installer state contains an unsafe entry.',
      observed: `${path} is not a supported non-symbolic-link directory or file.`,
      reason:
        'Symbolic links and special files could redirect installer state or credential access outside the protected state directory.',
      operatorAction:
        'Move the existing entry aside, inspect it manually, and restore only a developer-owned regular file or directory.',
      rerun: 'qiln doctor',
      cause: error,
    })
  }
  return new QilnInstallerError({
    code: 'STATE_ACCESS_FAILED',
    check: 'installer state access',
    summary: 'The Qiln installer state path could not be inspected.',
    observed: `The state path ${path} is not accessible.`,
    reason: 'Qiln cannot prove that existing state and credentials are safe to use.',
    operatorAction: 'Inspect the state path and its parent directory permissions manually.',
    rerun: 'qiln doctor',
    cause: error,
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
    throw new QilnInstallerError({
      code: 'INVALID_INSTALLATION_STATE',
      check: 'installer state format',
      summary: 'The existing Qiln installation state is invalid or incompatible.',
      observed:
        'installation.json does not contain the expected version, project, instance, and full lowercase image fingerprint.',
      reason: 'Qiln cannot use malformed state as the deterministic installation pin.',
      operatorAction: 'Move the state file aside for manual inspection. Do not discard credentials or persistent data.',
      rerun: 'qiln doctor',
    })
  }
  const expectedKeys = ['imageFingerprint', 'instanceName', 'projectName', 'version']
  const actualKeys = Object.keys(value).sort()
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new QilnInstallerError({
      code: 'INVALID_INSTALLATION_STATE',
      check: 'installer state format',
      summary: 'The existing Qiln installation state has unsupported fields.',
      observed: 'installation.json does not match the installer state schema.',
      reason: 'Qiln must not silently reinterpret state produced by an incompatible installer revision.',
      operatorAction: 'Review the installed Qiln CLI version and the existing state file before proceeding.',
      rerun: 'qiln doctor',
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
    throw new QilnInstallerError({
      code: 'INVALID_INSTALLATION_STATE',
      check: 'installer state JSON',
      summary: 'The existing Qiln installation state is not valid JSON.',
      observed: 'installation.json could not be decoded.',
      reason: 'Qiln cannot safely determine the immutable installation image pin.',
      operatorAction: 'Move the state file aside and inspect it manually before rerunning Qiln.',
      rerun: 'qiln doctor',
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

function rosterReadError(error: unknown, path: string): QilnInstallerError {
  if (isErrorCode(error, 'ENOENT')) {
    return new QilnInstallerError({
      code: 'AUTHORIZED_KEYS_NOT_FOUND',
      check: 'orchestrator authorized-key roster',
      summary: 'The orchestrator authorized-key roster could not be read.',
      observed: `No readable roster was found at ${path}.`,
      reason: 'A supplied roster must resolve to one stable developer-owned regular file.',
      operatorAction: 'Create a normal OpenSSH public-key roster and pass it with --authorized-keys.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
      cause: error,
    })
  }
  if (error instanceof FileValidationError && error.kind === 'owner') {
    return new QilnInstallerError({
      code: 'INVALID_AUTHORIZED_KEYS_OWNER',
      check: 'orchestrator authorized-key roster ownership',
      summary: 'The orchestrator authorized-key roster is not owned by the invoking developer.',
      observed: `${path} does not have the expected UID ${currentUserId()} ownership.`,
      reason: 'The unprivileged invoking developer must control the public-key roster supplied to the installation.',
      operatorAction: 'Copy the intended public keys into a developer-owned regular file.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
    })
  }
  return new QilnInstallerError({
    code: 'INVALID_AUTHORIZED_KEYS_FILE',
    check: 'orchestrator authorized-key roster',
    summary: 'The orchestrator authorized-key roster could not be safely read.',
    observed: `${path} could not be opened as a stable bounded regular file.`,
    reason: 'Qiln must validate one stable roster without following redirected credential input.',
    operatorAction: 'Copy the intended public keys into a regular developer-owned file and pass that path explicitly.',
    rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
    cause: error,
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
    if (error instanceof QilnInstallerError) {
      throw error
    }
    throw stateError(error, directory.path, true)
  }
}

export async function writeInstallationState(directory: Dir, imageFingerprint: string): Promise<InstallationState> {
  if (!FULL_FINGERPRINT_PATTERN.test(imageFingerprint)) {
    throw new QilnInstallerError({
      code: 'INVALID_IMAGE_FINGERPRINT',
      check: 'installation image pin',
      summary: 'The selected image fingerprint is not a full lowercase SHA-256 value.',
      observed: 'The proposed installation state fingerprint is malformed.',
      reason: 'Qiln persists only immutable full provider image identities.',
      operatorAction: 'Reconcile the selected Incus image and rerun qiln up.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
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
    throw new QilnInstallerError({
      code: 'INVALID_AUTHORIZED_KEYS_CONTENT',
      check: 'orchestrator authorized-key roster content',
      summary: 'The orchestrator authorized-key roster is not valid UTF-8 text.',
      observed: 'The validated roster snapshot could not be decoded as UTF-8.',
      reason: 'The roster must contain only normal bounded OpenSSH public-key lines and comments.',
      operatorAction: 'Export the intended public keys again using normal OpenSSH public-key text format.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
      cause: error,
    })
  }
  let publicKeyCount = 0
  for (const [index, line] of content.split('\n').entries()) {
    if (line.includes('\r') || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(line)) {
      throw new QilnInstallerError({
        code: 'INVALID_AUTHORIZED_KEYS_CONTENT',
        check: 'orchestrator authorized-key roster content',
        summary: 'The orchestrator authorized-key roster contains control characters.',
        observed: `Unsupported content was found at line ${index + 1}.`,
        reason: 'The roster must contain only normal bounded OpenSSH public-key lines and comments.',
        operatorAction: 'Remove control characters and ensure the file uses Unix line endings.',
        rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
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
      throw new QilnInstallerError({
        code: 'INVALID_AUTHORIZED_KEYS_CONTENT',
        check: 'orchestrator authorized-key roster content',
        summary: 'The orchestrator authorized-key roster contains an unsupported public-key line.',
        observed: `Line ${index + 1} is not a normal supported OpenSSH public-key line.`,
        reason:
          'Authorized-keys options, certificates, private keys, and malformed public keys are not accepted as installer roster entries.',
        operatorAction: 'Replace the line with a normal OpenSSH public key generated by an approved SSH key tool.',
        rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
      })
    }
    const decoded = Buffer.from(encodedKey, 'base64')
    if (decoded.length === 0 || decoded.toString('base64') !== encodedKey) {
      throw new QilnInstallerError({
        code: 'INVALID_AUTHORIZED_KEYS_CONTENT',
        check: 'orchestrator authorized-key roster content',
        summary: 'The orchestrator authorized-key roster contains a non-canonical public-key blob.',
        observed: `Line ${index + 1} does not contain canonical Base64 public-key data.`,
        reason: 'The installer must copy an unambiguous, validated SSH public-key roster.',
        operatorAction: 'Export the public key again in normal OpenSSH public-key format.',
        rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
      })
    }
    publicKeyCount++
  }
  if (publicKeyCount === 0) {
    throw new QilnInstallerError({
      code: 'EMPTY_AUTHORIZED_KEYS_ROSTER',
      check: 'orchestrator authorized-key roster content',
      summary: 'The orchestrator authorized-key roster contains no public keys.',
      observed: 'The selected roster snapshot contains only blank lines or comments.',
      reason: 'A supplied development roster must contain at least one explicitly selected public key.',
      operatorAction: 'Add at least one normal OpenSSH public key to the roster.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  const validation = await withTemp(roster, path => runProcess(sshKeygenExecutable, ['-l', '-f', path]))
  if (validation.exitCode !== 0 || validation.stdout.trim() === '') {
    throw new QilnInstallerError({
      code: 'INVALID_AUTHORIZED_KEYS_ROSTER',
      check: 'orchestrator authorized-key roster cryptographic structure',
      summary: 'OpenSSH could not validate the orchestrator authorized-key roster.',
      observed: 'The validated roster snapshot failed ssh-keygen public-key inspection.',
      reason: 'Textual shape alone does not prove that each encoded SSH key has a valid supported structure.',
      operatorAction: 'Replace malformed entries with public keys accepted by ssh-keygen -l -f <roster>.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    })
  }
  return roster
}
