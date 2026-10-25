import { randomBytes } from 'node:crypto'
import { chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
import { InstallerError } from '../diagnostic/error'
import { IncusApiError } from '../incus/client'
import { isIncusApiStatus, toInstallerError } from '../incus/errors'
import { runProcess } from '../process'
import { validateContainerImage } from '../checks/image'
import { Dir, FileValidationError, read, readChild, withDir, withTemp, writeChild } from '../state/files'
import { assertInstance } from './instance'
import { assertNetwork } from './network'
import { validateRoster } from './roster'
import { INSTALLER_SPEC } from './spec'
import { pinned, readInstallation } from './state'
import { assertVolume } from './storage'
import type { InstallationInputs } from './types'
import type { FileSnapshot } from '../state/files'
import type { IncusClient } from '../incus/client'
import type { IncusConfigMap, IncusDevicesMap, IncusInstance, IncusInstancePut, IncusRead } from '../incus/types'

const FULL_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/
const UNSUPPORTED_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const RERUN =
  'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]'

type LocalOutcome = 'generated' | 'reused' | 'roster-updated'
type DeliveryOutcome = 'transferred' | 'reused'

interface LocalFiles {
  authorizedKeys: FileSnapshot
  nats: FileSnapshot
  host: FileSnapshot
  gatewayKey: FileSnapshot
}

interface Credentials extends LocalFiles {
  values: IncusConfigMap
}

interface CurrentInstance {
  read: IncusRead<IncusInstance>
}

interface Delivery {
  outcome: DeliveryOutcome
  expected: IncusInstancePut
}

export interface CredentialConvergence {
  localOutcome: LocalOutcome
  deliveryOutcome: DeliveryOutcome
  imageFingerprint: string
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

function snapshot(bytes: Uint8Array): FileSnapshot {
  return Object.freeze({
    bytes,
    size: bytes.byteLength,
  })
}

function text(snapshotValue: FileSnapshot, _: string): string {
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
      retry: RERUN,
    })
  }
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseNats(value: string): string {
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
      retry: RERUN,
    })
  }
  return match[1]
}

function parseHost(value: string): { natsToken: string; cookieSecret: string } {
  const length = INSTALLER_SPEC.credentials.secretBytes * 2
  const pattern = new RegExp(`^NATS_TOKEN=([a-f0-9]{${length}})\\nFASTIFY_COOKIE_SECRET=([a-f0-9]{${length}})\\n$`)
  const match = pattern.exec(value)
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new InstallerError({
      code: 'INVALID_HOST_CREDENTIAL',
      facts: [['Observed', 'qiln-host.env contains missing, duplicate, malformed, or unsupported fields.']],
      retry: RERUN,
    })
  }
  return {
    natsToken: match[1],
    cookieSecret: match[2],
  }
}

async function validateGatewayKey(privateKey: FileSnapshot, sshKeygen: string): Promise<void> {
  const derivedPublicKey = await withTemp(privateKey, path =>
    runProcess(sshKeygen, ['-y', '-P', '', '-f', path], {
      maxOutputBytes: INSTALLER_SPEC.credentials.limits.gatewayKey,
    }),
  )
  if (derivedPublicKey.exitCode !== 0) {
    throw new InstallerError({
      code: 'INVALID_GATEWAY_HOST_KEY',
      facts: [['Observed', 'ssh-keygen could not derive a public key using an empty passphrase.']],
      retry: RERUN,
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
      retry: RERUN,
    })
  }
}

function credentialReadError(error: unknown, _: string): InstallerError {
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
      retry: RERUN,
    })
  }
  return new InstallerError({
    code: 'LOCAL_CREDENTIAL_READ_FAILED',
    facts: [['Observed', 'The credential could not be opened as one stable bounded regular file.']],
    retry: RERUN,
  })
}

async function readCredential(directory: Dir, name: string, maxSize: number): Promise<FileSnapshot> {
  try {
    return await readChild(directory, name, {
      owner: currentUserId(),
      mode: 0o600,
      minSize: 1,
      maxSize,
    })
  } catch (error: unknown) {
    throw credentialReadError(error, name)
  }
}

async function files(directory: Dir): Promise<'absent' | LocalFiles> {
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
      retry: RERUN,
    })
  }
  const limits = INSTALLER_SPEC.credentials.limits
  return {
    authorizedKeys: await readCredential(directory, configured.authorizedKeys, limits.authorizedKeys),
    nats: await readCredential(directory, configured.nats, limits.nats),
    host: await readCredential(directory, configured.host, limits.host),
    gatewayKey: await readCredential(directory, configured.gatewayKey, limits.gatewayKey),
  }
}

async function validate(local: LocalFiles, sshKeygen: string): Promise<Credentials> {
  await validateRoster(local.authorizedKeys, sshKeygen)
  const natsText = text(local.nats, 'NATS')
  const hostText = text(local.host, 'Host')
  const natsToken = parseNats(natsText)
  const host = parseHost(hostText)
  if (natsToken !== host.natsToken) {
    throw new InstallerError({
      code: 'LOCAL_CREDENTIAL_TOKEN_MISMATCH',
      facts: [['Observed', 'The NATS token in nats-server.conf differs from the token in qiln-host.env.']],
      retry: RERUN,
    })
  }
  await validateGatewayKey(local.gatewayKey, sshKeygen)
  const keys = INSTALLER_SPEC.credentials.keys
  return {
    ...local,
    values: {
      [keys.nats]: natsText,
      [keys.host]: hostText,
      [keys.authorizedKeys]: text(local.authorizedKeys, 'authorized-key roster'),
      [keys.gatewayKey]: Buffer.from(local.gatewayKey.bytes).toString('base64'),
    },
  }
}

async function load(directory: Dir, sshKeygen: string): Promise<'absent' | Credentials> {
  const state = await files(directory)
  if (state === 'absent') {
    return 'absent'
  }
  return await validate(state, sshKeygen)
}

function collision(config: Readonly<IncusConfigMap>): void {
  const prefixes = INSTALLER_SPEC.credentials.prefixes
  for (const suffix of INSTALLER_SPEC.credentials.managedSuffixes) {
    const textKey = `${prefixes.text}${suffix}`
    const binaryKey = `${prefixes.binary}${suffix}`
    if (Object.hasOwn(config, textKey) && Object.hasOwn(config, binaryKey)) {
      throw new InstallerError({
        code: 'INSTANCE_CREDENTIAL_NAMESPACE_COLLISION',
        facts: [['Observed', `Both credential namespaces are populated for managed suffix '${suffix}'.`]],
        retry: RERUN,
      })
    }
  }
}

function hasManagedCredentials(config: Readonly<IncusConfigMap>): boolean {
  const prefixes = INSTALLER_SPEC.credentials.prefixes
  return INSTALLER_SPEC.credentials.managedSuffixes.some(
    suffix =>
      Object.hasOwn(config, `${prefixes.text}${suffix}`) || Object.hasOwn(config, `${prefixes.binary}${suffix}`),
  )
}

async function current(directory: Dir, client: IncusClient, inputs: InstallationInputs): Promise<CurrentInstance> {
  const installation = pinned(await readInstallation(directory))
  if (!installation) {
    throw new InstallerError({
      code: 'INSTALLATION_STATE_REQUIRED',
      facts: [['Observed', 'installation.json is absent or holds no image pin after image convergence.']],
      retry: RERUN,
    })
  }
  let instance: IncusRead<IncusInstance> | null
  try {
    instance = await client.getInstanceWithEtagOrNull(INSTALLER_SPEC.orchestrator.name)
  } catch (error: unknown) {
    throw toInstallerError(error, {
      check: 'credential delivery instance inspection',
      operation: 'read the stopped orchestrator instance and its ETag',
      rerun: RERUN,
    })
  }
  if (!instance) {
    throw new InstallerError({
      code: 'ORCHESTRATOR_INSTANCE_REQUIRED',
      facts: [['Observed', `Incus did not return '${INSTALLER_SPEC.orchestrator.name}'.`]],
      retry: RERUN,
    })
  }
  collision(instance.value.config)
  assertInstance(instance.value, installation.imageFingerprint, inputs)
  const signature = instance.value.config['volatile.base_image']
  if (
    typeof signature !== 'string' ||
    !FULL_FINGERPRINT_PATTERN.test(signature) ||
    signature !== installation.imageFingerprint
  ) {
    throw new InstallerError({
      code: 'ORCHESTRATOR_IMAGE_SIGNATURE_MISMATCH',
      facts: [
        ['Observed', 'The instance base-image signature is missing, malformed, or different from installation.json.'],
      ],
      retry: RERUN,
    })
  }
  return {
    read: instance,
  }
}

function natsConfig(token: string): string {
  const config = INSTALLER_SPEC.credentials.nats
  return `server_name: ${config.serverName}\nhost: ${config.host}\nport: ${config.port}\n\nauthorization {\n  token: "${token}"\n}\n`
}

function hostEnvironment(natsToken: string, cookieSecret: string): string {
  return `NATS_TOKEN=${natsToken}\nFASTIFY_COOKIE_SECRET=${cookieSecret}\n`
}

async function gatewayKey(sshKeygen: string): Promise<FileSnapshot> {
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
        retry: RERUN,
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
    await validateGatewayKey(key, sshKeygen)
    return key
  })
}

async function generate(
  directory: Dir,
  roster: FileSnapshot,
  sshKeygen: string,
  client: IncusClient,
  inputs: InstallationInputs,
): Promise<Credentials> {
  const target = await current(directory, client, inputs)
  if (hasManagedCredentials(target.read.value.config)) {
    throw new InstallerError({
      code: 'LOCAL_CREDENTIAL_RECOVERY_REQUIRED',
      facts: [
        [
          'Observed',
          'The stopped orchestrator contains one or more managed credential keys while the local set is absent.',
        ],
      ],
      retry: RERUN,
    })
  }
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
    gatewayKey: await gatewayKey(sshKeygen),
  }
  await validate(generated, sshKeygen)
  const names = INSTALLER_SPEC.credentials.files
  await writeChild(directory, names.authorizedKeys, generated.authorizedKeys.bytes, 0o600)
  await writeChild(directory, names.nats, generated.nats.bytes, 0o600)
  await writeChild(directory, names.host, generated.host.bytes, 0o600)
  await writeChild(directory, names.gatewayKey, generated.gatewayKey.bytes, 0o600)
  const persisted = await load(directory, sshKeygen)
  if (persisted === 'absent') {
    throw new InstallerError({
      code: 'LOCAL_CREDENTIAL_PERSISTENCE_FAILED',
      facts: [['Observed', 'The protected state directory did not contain a complete valid credential set.']],
      retry: RERUN,
    })
  }
  return persisted
}

function put(instance: IncusInstance, values: Readonly<IncusConfigMap>): IncusInstancePut {
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

function sameMap(left: Readonly<IncusConfigMap>, right: Readonly<IncusConfigMap>): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  )
}

function sameDevices(left: Readonly<IncusDevicesMap>, right: Readonly<IncusDevicesMap>): boolean {
  const leftNames = Object.keys(left).sort()
  const rightNames = Object.keys(right).sort()
  return (
    leftNames.length === rightNames.length &&
    leftNames.every((name, index) => {
      const leftDevice = left[name]
      const rightDevice = right[name]
      return (
        name === rightNames[index] &&
        leftDevice !== undefined &&
        rightDevice !== undefined &&
        sameMap(leftDevice, rightDevice)
      )
    })
  )
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function samePut(instance: IncusInstance, expected: IncusInstancePut): boolean {
  return (
    instance.architecture === expected.architecture &&
    instance.description === expected.description &&
    instance.ephemeral === expected.ephemeral &&
    instance.stateful === expected.stateful &&
    sameStrings(instance.profiles, expected.profiles) &&
    sameMap(instance.config, expected.config) &&
    sameDevices(instance.devices, expected.devices)
  )
}

function matches(config: Readonly<IncusConfigMap>, values: Readonly<IncusConfigMap>): boolean {
  return Object.entries(values).every(([key, value]) => config[key] === value)
}

async function deliver(
  directory: Dir,
  client: IncusClient,
  sshKeygen: string,
  inputs: InstallationInputs,
): Promise<Delivery> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const target = await current(directory, client, inputs)
    const local = await load(directory, sshKeygen)
    if (local === 'absent') {
      throw new InstallerError({
        code: 'LOCAL_CREDENTIAL_SET_REQUIRED',
        facts: [['Observed', 'The protected installer state directory contains no credential set.']],
        retry: RERUN,
      })
    }
    const expected = put(target.read.value, local.values)
    if (matches(target.read.value.config, local.values)) {
      return {
        outcome: 'reused',
        expected,
      }
    }
    try {
      const operation = await client.updateInstance(INSTALLER_SPEC.orchestrator.name, expected, target.read.etag)
      try {
        await client.waitOperation(operation)
      } catch (error: unknown) {
        throw toInstallerError(error, {
          check: 'guarded orchestrator credential delivery',
          operation: 'wait for the guarded complete instance update',
          rerun: RERUN,
        })
      }
      return {
        outcome: 'transferred',
        expected,
      }
    } catch (error: unknown) {
      if (isIncusApiStatus(error, 412) && attempt === 0) {
        continue
      }
      if (isIncusApiStatus(error, 412)) {
        throw new InstallerError({
          code: 'INCUS_ETAG_CONFLICT',
          facts: [['Observed', 'Incus returned HTTP 412 after the instance was re-read and revalidated once.']],
          retry: RERUN,
        })
      }
      if (error instanceof IncusApiError) {
        throw toInstallerError(error, {
          check: 'guarded orchestrator credential delivery',
          operation: 'apply the complete stopped instance credential configuration',
          rerun: RERUN,
        })
      }
      throw error
    }
  }
  throw new Error('Credential delivery retry state was exhausted unexpectedly.')
}

async function verify(
  directory: Dir,
  client: IncusClient,
  sshKeygen: string,
  expected: IncusInstancePut,
  verifyAlias: boolean,
  inputs: InstallationInputs,
): Promise<string> {
  const installation = pinned(await readInstallation(directory))
  if (!installation) {
    throw new InstallerError({
      code: 'FINAL_INSTALLATION_STATE_MISSING',
      facts: [['Observed', 'installation.json could not be re-read after credential convergence.']],
      retry: RERUN,
    })
  }
  const { layout } = inputs
  let image
  let network
  let volume
  let instance
  try {
    image = await client.getImage(installation.imageFingerprint)
    network = await client.getNetwork(layout.network.name)
    volume = await client.getStoragePoolVolume(
      layout.pool.name,
      INSTALLER_SPEC.storage.volumeType,
      layout.postgres.volumeName,
    )
    instance = await client.getInstance(INSTALLER_SPEC.orchestrator.name)
  } catch (error: unknown) {
    throw toInstallerError(error, {
      check: 'final stopped-installation verification',
      operation: 're-read the selected image, network, volume, and stopped orchestrator',
      rerun: RERUN,
    })
  }
  validateContainerImage(image, installation.imageFingerprint, inputs.architecture)
  assertNetwork(network, layout)
  assertVolume(volume, layout)
  collision(instance.config)
  assertInstance(instance, installation.imageFingerprint, inputs)
  const local = await load(directory, sshKeygen)
  if (local === 'absent') {
    throw new InstallerError({
      code: 'FINAL_LOCAL_CREDENTIAL_SET_MISSING',
      facts: [['Observed', 'The protected installer state directory no longer contains all four credentials.']],
      retry: RERUN,
    })
  }
  if (!matches(instance.config, local.values)) {
    throw new InstallerError({
      code: 'FINAL_INSTANCE_CREDENTIAL_MISMATCH',
      facts: [['Observed', 'At least one managed credential is missing or differs from the local source of truth.']],
      retry: RERUN,
    })
  }
  if (!samePut(instance, expected)) {
    throw new InstallerError({
      code: 'FINAL_INSTANCE_STATE_MISMATCH',
      facts: [
        [
          'Observed',
          'Profiles, devices, local configuration, or another writable instance field differs from the guarded state.',
        ],
      ],
      retry: RERUN,
    })
  }
  if (verifyAlias) {
    let alias
    try {
      alias = await client.getImageAlias(INSTALLER_SPEC.orchestrator.imageAlias)
    } catch (error: unknown) {
      throw toInstallerError(error, {
        check: 'final managed image-alias verification',
        operation: 're-read the managed split-image alias',
        rerun: RERUN,
      })
    }
    if (alias.target !== installation.imageFingerprint) {
      throw new InstallerError({
        code: 'FINAL_IMAGE_ALIAS_MISMATCH',
        facts: [['Observed', 'The alias target differs from the persisted full image fingerprint.']],
        retry: RERUN,
      })
    }
  }
  return installation.imageFingerprint
}

export async function convergeCredentials(options: {
  directory: Dir
  client: IncusClient
  sshKeygen: string
  roster: FileSnapshot | null
  verifyAlias: boolean
  inputs: InstallationInputs
}): Promise<CredentialConvergence> {
  let local = await load(options.directory, options.sshKeygen)
  let localOutcome: LocalOutcome
  if (local === 'absent') {
    if (!options.roster) {
      throw new InstallerError({
        code: 'AUTHORIZED_KEYS_REQUIRED',
        facts: [['Observed', 'No local credential files or validated authorized-key roster are available.']],
        retry: RERUN,
      })
    }
    local = await generate(options.directory, options.roster, options.sshKeygen, options.client, options.inputs)
    localOutcome = 'generated'
  } else if (options.roster) {
    await writeChild(options.directory, INSTALLER_SPEC.credentials.files.authorizedKeys, options.roster.bytes, 0o600)
    const updated = await load(options.directory, options.sshKeygen)
    if (updated === 'absent') {
      throw new Error('Credential set disappeared after authorized-key replacement.')
    }
    local = updated
    localOutcome = 'roster-updated'
  } else {
    localOutcome = 'reused'
  }
  const delivery = await deliver(options.directory, options.client, options.sshKeygen, options.inputs)
  const imageFingerprint = await verify(
    options.directory,
    options.client,
    options.sshKeygen,
    delivery.expected,
    options.verifyAlias,
    options.inputs,
  )
  return {
    localOutcome,
    deliveryOutcome: delivery.outcome,
    imageFingerprint,
  }
}
