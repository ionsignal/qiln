import { randomBytes } from 'node:crypto'
import { chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
import { INSTALLER_SPEC } from './spec'
import { validateRoster } from './roster'
import { InstallerError } from '../diagnostic/error'
import { runProcess } from '../transport/process'
import { currentUserId } from '../state/user'
import type { FileSnapshot } from '../state/files'
import { Dir, FileValidationError, read, readChild, withDir, withTemp, writeChild } from '../state/files'
import type { IncusConfigMap, IncusDevicesMap, IncusInstance, IncusInstancePut } from '../transport/incus/types'

const UNSUPPORTED_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

export interface LocalFiles {
  authorizedKeys: FileSnapshot
  nats: FileSnapshot
  host: FileSnapshot
  gatewayKey: FileSnapshot
}

/**
 * A validated local credential set. `values` is exactly what the instance must
 * hold, so it is the one source for comparison and delivery.
 */
export interface Credentials extends LocalFiles {
  values: IncusConfigMap
}

function snapshot(bytes: Uint8Array): FileSnapshot {
  return Object.freeze({
    bytes,
    size: bytes.byteLength,
  })
}

function text(snapshotValue: FileSnapshot, retry: string): string {
  try {
    const value = new TextDecoder('utf-8', {
      fatal: true,
    }).decode(snapshotValue.bytes)
    if (value.includes('\r') || UNSUPPORTED_CONTROL_PATTERN.test(value)) {
      throw new Error('Unsupported credential control character.')
    }
    return value
  } catch (error: unknown) {
    throw new InstallerError({
      code: 'INVALID_LOCAL_CREDENTIAL',
      facts: [['Observed', 'The credential is not valid supported UTF-8 text.']],
      retry,
    })
  }
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseNats(value: string, retry: string): string {
  const length = INSTALLER_SPEC.credentials.secretBytes * 2
  const config = INSTALLER_SPEC.credentials.nats
  const pattern = new RegExp(
    `^server_name: ${escapePattern(config.serverName)}\\nhost: ${escapePattern(config.host)}\\nport: ${config.port}\\n\\nauthorization \\{\\n  token: "([a-f0-9]{${length}})"\\n\\}\\n$`,
  )
  const match = pattern.exec(value)
  if (!match || match[1] === undefined) {
    throw new InstallerError({
      code: 'INVALID_NATS_CREDENTIAL',
      facts: [['Observed', 'nats-server.conf does not match the installer-owned configuration schema.']],
      retry,
    })
  }
  return match[1]
}

function parseHost(value: string, retry: string): { natsToken: string; cookieSecret: string } {
  const length = INSTALLER_SPEC.credentials.secretBytes * 2
  const pattern = new RegExp(`^NATS_TOKEN=([a-f0-9]{${length}})\\nFASTIFY_COOKIE_SECRET=([a-f0-9]{${length}})\\n$`)
  const match = pattern.exec(value)
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new InstallerError({
      code: 'INVALID_HOST_CREDENTIAL',
      facts: [['Observed', 'qiln-host.env contains missing, duplicate, malformed, or unsupported fields.']],
      retry,
    })
  }
  return {
    natsToken: match[1],
    cookieSecret: match[2],
  }
}

async function validateGatewayKey(privateKey: FileSnapshot, sshKeygen: string, retry: string): Promise<void> {
  const derivedPublicKey = await withTemp(privateKey, path =>
    runProcess(sshKeygen, ['-y', '-P', '', '-f', path], {
      maxOutputBytes: INSTALLER_SPEC.credentials.limits.gatewayKey,
    }),
  )
  if (derivedPublicKey.exitCode !== 0) {
    throw new InstallerError({
      code: 'INVALID_GATEWAY_HOST_KEY',
      facts: [['Observed', 'ssh-keygen could not derive a public key using an empty passphrase.']],
      retry,
    })
  }
  const publicKey = derivedPublicKey.stdout.trim()
  const publicKeyFields = publicKey.split(/\s+/)
  if (
    publicKey.includes('\r') ||
    publicKey.includes('\n') ||
    publicKeyFields.length < 2 ||
    publicKeyFields[0] !== INSTALLER_SPEC.credentials.gatewayAlgorithm ||
    publicKeyFields[1] === undefined ||
    publicKeyFields[1] === ''
  ) {
    throw new InstallerError({
      code: 'INVALID_GATEWAY_HOST_KEY_ALGORITHM',
      facts: [
        ['Observed', 'The public key derived from the retained private key does not use the required algorithm.'],
      ],
      retry,
    })
  }
}

function credentialReadError(error: unknown, retry: string): InstallerError {
  if (error instanceof FileValidationError) {
    const reason = {
      type: 'The credential entry is not a normal regular file.',
      owner: 'The credential entry is not owned by the invoking developer.',
      mode: 'The credential entry does not have mode 0600.',
      size: 'The credential entry is empty or exceeds its configured size limit.',
      changed: 'The credential entry changed while it was being read.',
    }[error.kind]
    return new InstallerError({
      code: 'INVALID_LOCAL_CREDENTIAL_FILE',
      facts: [['Observed', reason]],
      retry,
    })
  }
  return new InstallerError({
    code: 'LOCAL_CREDENTIAL_READ_FAILED',
    facts: [['Observed', 'The credential could not be opened as one stable bounded regular file.']],
    retry,
  })
}

async function readCredential(directory: Dir, name: string, maxSize: number, retry: string): Promise<FileSnapshot> {
  try {
    return await readChild(directory, name, {
      owner: currentUserId(),
      mode: 0o600,
      minSize: 1,
      maxSize,
    })
  } catch (error: unknown) {
    throw credentialReadError(error, retry)
  }
}

async function files(directory: Dir, retry: string): Promise<'absent' | LocalFiles> {
  const names = new Set(await directory.list())
  const configured = INSTALLER_SPEC.credentials.files
  const expected = [configured.authorizedKeys, configured.nats, configured.host, configured.gatewayKey]
  const present = expected.filter(name => names.has(name))
  if (present.length === 0) {
    return 'absent'
  }
  if (present.length !== expected.length) {
    const missing = expected.filter(name => !names.has(name))
    throw new InstallerError({
      code: 'PARTIAL_LOCAL_CREDENTIAL_SET',
      facts: [
        ['Observed', `Present files: ${present.join(', ') || 'none'}; missing files: ${missing.join(', ') || 'none'}.`],
      ],
      retry,
    })
  }
  const limits = INSTALLER_SPEC.credentials.limits
  return {
    authorizedKeys: await readCredential(directory, configured.authorizedKeys, limits.authorizedKeys, retry),
    nats: await readCredential(directory, configured.nats, limits.nats, retry),
    host: await readCredential(directory, configured.host, limits.host, retry),
    gatewayKey: await readCredential(directory, configured.gatewayKey, limits.gatewayKey, retry),
  }
}

async function validate(local: LocalFiles, sshKeygen: string, retry: string): Promise<Credentials> {
  await validateRoster(local.authorizedKeys, sshKeygen, retry)
  const natsText = text(local.nats, retry)
  const hostText = text(local.host, retry)
  const natsToken = parseNats(natsText, retry)
  const host = parseHost(hostText, retry)
  if (natsToken !== host.natsToken) {
    throw new InstallerError({
      code: 'LOCAL_CREDENTIAL_TOKEN_MISMATCH',
      facts: [['Observed', 'The NATS token in nats-server.conf differs from the token in qiln-host.env.']],
      retry,
    })
  }
  await validateGatewayKey(local.gatewayKey, sshKeygen, retry)
  const keys = INSTALLER_SPEC.credentials.keys
  return {
    ...local,
    values: {
      [keys.nats]: natsText,
      [keys.host]: hostText,
      [keys.authorizedKeys]: text(local.authorizedKeys, retry),
      [keys.gatewayKey]: Buffer.from(local.gatewayKey.bytes).toString('base64'),
    },
  }
}

/**
 * Reads and validates the retained local set. A partial or invalid set throws,
 * and an absent one is the only state from which a first set may be generated.
 */
export async function loadCredentials(
  directory: Dir,
  sshKeygen: string,
  retry: string,
): Promise<'absent' | Credentials> {
  const state = await files(directory, retry)
  if (state === 'absent') {
    return 'absent'
  }
  return await validate(state, sshKeygen, retry)
}

/**
 * The first managed suffix whose text and binary credential namespaces are both
 * populated, if any.
 */
function collidingSuffix(config: Readonly<IncusConfigMap>): string | undefined {
  const prefixes = INSTALLER_SPEC.credentials.prefixes
  return INSTALLER_SPEC.credentials.managedSuffixes.find(
    suffix => Object.hasOwn(config, `${prefixes.text}${suffix}`) && Object.hasOwn(config, `${prefixes.binary}${suffix}`),
  )
}

export function hasCollision(config: Readonly<IncusConfigMap>): boolean {
  return collidingSuffix(config) !== undefined
}

/**
 * The two credential namespaces must never both hold the same managed suffix.
 */
export function requireNoCollision(config: Readonly<IncusConfigMap>, retry: string): void {
  const suffix = collidingSuffix(config)
  if (suffix !== undefined) {
    throw new InstallerError({
      code: 'INSTANCE_CREDENTIAL_NAMESPACE_COLLISION',
      facts: [['Observed', `Both credential namespaces are populated for managed suffix '${suffix}'.`]],
      retry,
    })
  }
}

export function hasManagedCredentials(config: Readonly<IncusConfigMap>): boolean {
  const prefixes = INSTALLER_SPEC.credentials.prefixes
  return INSTALLER_SPEC.credentials.managedSuffixes.some(
    suffix =>
      Object.hasOwn(config, `${prefixes.text}${suffix}`) || Object.hasOwn(config, `${prefixes.binary}${suffix}`),
  )
}

function natsConfig(token: string): string {
  const config = INSTALLER_SPEC.credentials.nats
  return `server_name: ${config.serverName}\nhost: ${config.host}\nport: ${config.port}\n\nauthorization {\n  token: "${token}"\n}\n`
}

function hostEnvironment(natsToken: string, cookieSecret: string): string {
  return `NATS_TOKEN=${natsToken}\nFASTIFY_COOKIE_SECRET=${cookieSecret}\n`
}

async function gatewayKey(sshKeygen: string, retry: string): Promise<FileSnapshot> {
  return await withDir(async directory => {
    const keyPath = join(directory, INSTALLER_SPEC.credentials.files.gatewayKey)
    const generated = await runProcess(sshKeygen, [
      '-q',
      '-t',
      'ed25519',
      '-f',
      keyPath,
      '-N',
      '',
      '-C',
      INSTALLER_SPEC.credentials.gatewayComment,
    ])
    if (generated.exitCode !== 0) {
      throw new InstallerError({
        code: 'GATEWAY_HOST_KEY_GENERATION_FAILED',
        facts: [['Observed', 'ssh-keygen did not complete successfully in the private temporary directory.']],
        retry,
      })
    }
    await rm(`${keyPath}.pub`, {
      force: true,
    })
    await chmod(keyPath, 0o600)
    const key = await read(keyPath, {
      owner: currentUserId(),
      mode: 0o600,
      minSize: 1,
      maxSize: INSTALLER_SPEC.credentials.limits.gatewayKey,
    })
    await validateGatewayKey(key, sshKeygen, retry)
    return key
  })
}

/**
 * Local-only first generation from a validated roster. It writes the four
 * protected files and returns the set read back from disk. The caller decides
 * that generation is allowed, and an interrupted write leaves a partial set
 * that the next read refuses.
 */
export async function createCredentials(
  directory: Dir,
  roster: FileSnapshot,
  sshKeygen: string,
  retry: string,
): Promise<Credentials> {
  const natsToken = randomBytes(INSTALLER_SPEC.credentials.secretBytes).toString(
    INSTALLER_SPEC.credentials.secretEncoding,
  )
  const cookieSecret = randomBytes(INSTALLER_SPEC.credentials.secretBytes).toString(
    INSTALLER_SPEC.credentials.secretEncoding,
  )
  const generated: LocalFiles = {
    authorizedKeys: roster,
    nats: snapshot(new TextEncoder().encode(natsConfig(natsToken))),
    host: snapshot(new TextEncoder().encode(hostEnvironment(natsToken, cookieSecret))),
    gatewayKey: await gatewayKey(sshKeygen, retry),
  }
  await validate(generated, sshKeygen, retry)
  const names = INSTALLER_SPEC.credentials.files
  await writeChild(directory, names.authorizedKeys, generated.authorizedKeys.bytes, 0o600)
  await writeChild(directory, names.nats, generated.nats.bytes, 0o600)
  await writeChild(directory, names.host, generated.host.bytes, 0o600)
  await writeChild(directory, names.gatewayKey, generated.gatewayKey.bytes, 0o600)
  const persisted = await loadCredentials(directory, sshKeygen, retry)
  if (persisted === 'absent') {
    throw new InstallerError({
      code: 'LOCAL_CREDENTIAL_PERSISTENCE_FAILED',
      facts: [['Observed', 'The protected state directory did not contain a complete valid credential set.']],
      retry,
    })
  }
  return persisted
}

/**
 * Local-only replacement of the authorized-key roster, which leaves the other
 * three credentials untouched.
 */
export async function replaceRoster(
  directory: Dir,
  roster: FileSnapshot,
  sshKeygen: string,
  retry: string,
): Promise<Credentials> {
  await writeChild(directory, INSTALLER_SPEC.credentials.files.authorizedKeys, roster.bytes, 0o600)
  const updated = await loadCredentials(directory, sshKeygen, retry)
  if (updated === 'absent') {
    throw new Error('Credential set disappeared after authorized-key replacement.')
  }
  return updated
}

/**
 * The complete guarded update body: the instance as read, with only the
 * managed credential values replaced and every other writable field kept.
 */
export function instancePut(instance: IncusInstance, values: Readonly<IncusConfigMap>): IncusInstancePut {
  const config: IncusConfigMap = {
    ...instance.config,
    ...values,
  }
  const devices: IncusDevicesMap = {}
  for (const [name, device] of Object.entries(instance.devices)) {
    devices[name] = {
      ...device,
    }
  }
  return {
    architecture: instance.architecture,
    config,
    description: instance.description,
    devices,
    ephemeral: instance.ephemeral,
    profiles: [...instance.profiles],
    stateful: instance.stateful,
  }
}

/**
 * Whether an instance configuration already holds every given credential value.
 */
export function matchesCredentials(config: Readonly<IncusConfigMap>, values: Readonly<IncusConfigMap>): boolean {
  return Object.entries(values).every(([key, value]) => config[key] === value)
}
