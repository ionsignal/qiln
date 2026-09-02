import { randomBytes } from 'node:crypto'
import { chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
import { QilnInstallerError } from '../error'
import { IncusApiError } from '../incus/client'
import { isIncusApiStatus, toInstallerError } from '../incus/errors'
import { runProcess } from '../process'
import { validateContainerImage } from '../checks/image'
import { Dir, FileValidationError, read, readChild, withDir, withTemp, writeChild } from './files'
import { assertInstance } from './instance'
import { assertNetwork } from './network'
import { INSTALLER_SPEC } from './spec'
import { inspectOpenInstallerState, validateRoster } from './state'
import { assertVolume } from './storage'
import type { FileSnapshot } from './files'
import type { InstallationState } from './state'
import type { LocalIncusClient } from '../incus/client'
import type { IncusConfigMap, IncusDevicesMap, IncusInstance, IncusInstancePut, IncusRead } from '../incus/types'

const FULL_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/
const UNSUPPORTED_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

type LocalOutcome = 'generated' | 'reused' | 'roster-updated'
type DeliveryOutcome = 'transferred' | 'reused'

interface LocalFiles {
  authorizedKeys: FileSnapshot
  nats: FileSnapshot
  host: FileSnapshot
  gatewayKey: FileSnapshot
}

interface Credentials extends LocalFiles {
  natsToken: string
  cookieSecret: string
  values: IncusConfigMap
}

interface CurrentInstance {
  installation: InstallationState
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
    throw new QilnInstallerError({
      code: 'UNSUPPORTED_PLATFORM',
      check: 'credential ownership',
      summary: 'Qiln cannot determine the invoking effective user ID.',
      observed: `Node platform '${process.platform}' does not expose process.geteuid().`,
      reason: 'Installer-owned credentials must belong to the invoking unprivileged developer.',
      operatorAction: 'Run Qiln on the supported Ubuntu host as the invoking developer.',
      rerun: 'qiln doctor',
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

function text(snapshotValue: FileSnapshot, label: string): string {
  try {
    const value = new TextDecoder('utf-8', {
      fatal: true,
    }).decode(snapshotValue.bytes)
    if (value.includes('\r') || UNSUPPORTED_CONTROL_PATTERN.test(value)) {
      throw new Error('Unsupported credential control character.')
    }
    return value
  } catch (error: unknown) {
    throw new QilnInstallerError({
      code: 'INVALID_LOCAL_CREDENTIAL',
      check: `${label} credential content`,
      summary: `The retained ${label} credential is malformed.`,
      observed: 'The credential is not valid supported UTF-8 text.',
      reason: 'Qiln never regenerates over malformed retained credentials.',
      operatorAction: 'Inspect and recover the complete local credential set manually before retrying.',
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
      cause: error,
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
    throw new QilnInstallerError({
      code: 'INVALID_NATS_CREDENTIAL',
      check: 'retained NATS credential configuration',
      summary: 'The retained NATS credential configuration is invalid.',
      observed: 'nats-server.conf does not match the installer-owned configuration schema.',
      reason: 'Qiln cannot safely reuse or silently replace malformed NATS authentication state.',
      operatorAction: 'Inspect and recover the complete local credential set manually before retrying.',
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
    })
  }
  return match[1]
}

function parseHost(value: string): { natsToken: string; cookieSecret: string } {
  const length = INSTALLER_SPEC.credentials.secretBytes * 2
  const pattern = new RegExp(`^NATS_TOKEN=([a-f0-9]{${length}})\\nFASTIFY_COOKIE_SECRET=([a-f0-9]{${length}})\\n$`)
  const match = pattern.exec(value)
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new QilnInstallerError({
      code: 'INVALID_HOST_CREDENTIAL',
      check: 'retained Host credential environment',
      summary: 'The retained Host credential environment is invalid.',
      observed: 'qiln-host.env contains missing, duplicate, malformed, or unsupported fields.',
      reason: 'Qiln cannot safely reuse or silently replace malformed Host authentication state.',
      operatorAction: 'Inspect and recover the complete local credential set manually before retrying.',
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
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
    throw new QilnInstallerError({
      code: 'INVALID_GATEWAY_HOST_KEY',
      check: 'retained SSH gateway host key',
      summary: 'The retained SSH gateway host key is invalid or encrypted.',
      observed: 'ssh-keygen could not derive a public key using an empty passphrase.',
      reason: 'The gateway requires one retained unencrypted Ed25519 OpenSSH private host key.',
      operatorAction: 'Inspect and recover the complete local credential set manually before retrying.',
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
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
    throw new QilnInstallerError({
      code: 'INVALID_GATEWAY_HOST_KEY_ALGORITHM',
      check: 'retained SSH gateway host-key algorithm',
      summary: 'The retained SSH gateway host key is not an Ed25519 key.',
      observed: 'The public key derived from the retained private key does not use the required algorithm.',
      reason: 'Qiln does not replace or convert retained gateway host keys automatically.',
      operatorAction: 'Inspect and recover the complete local credential set manually before retrying.',
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
    })
  }
}

function credentialReadError(error: unknown, name: string): QilnInstallerError {
  if (error instanceof FileValidationError) {
    const reason = {
      type: 'The credential entry is not a normal regular file.',
      owner: 'The credential entry is not owned by the invoking developer.',
      mode: 'The credential entry does not have mode 0600.',
      size: 'The credential entry is empty or exceeds its configured size limit.',
      changed: 'The credential entry changed while it was being read.',
    }[error.kind]
    return new QilnInstallerError({
      code: 'INVALID_LOCAL_CREDENTIAL_FILE',
      check: 'protected local credential set',
      summary: `The retained credential file '${name}' is unsafe or invalid.`,
      observed: reason,
      reason: 'Qiln never regenerates over an invalid retained credential set.',
      operatorAction: 'Inspect and recover all four local credential files manually before retrying.',
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
      cause: error,
    })
  }
  return new QilnInstallerError({
    code: 'LOCAL_CREDENTIAL_READ_FAILED',
    check: 'protected local credential set',
    summary: `The retained credential file '${name}' could not be read safely.`,
    observed: 'The credential could not be opened as one stable bounded regular file.',
    reason: 'Qiln cannot safely reuse or replace an unreadable credential set.',
    operatorAction: 'Inspect and recover all four local credential files manually before retrying.',
    rerun:
      'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
    cause: error,
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
    throw new QilnInstallerError({
      code: 'PARTIAL_LOCAL_CREDENTIAL_SET',
      check: 'protected local credential set',
      summary: 'The local Qiln credential set is incomplete.',
      observed: `Present files: ${present.join(', ') || 'none'}; missing files: ${missing.join(', ') || 'none'}.`,
      reason: 'Qiln never fills in, rotates, or regenerates part of a retained credential set.',
      operatorAction: 'Inspect and recover the complete four-file credential set manually before retrying.',
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
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
    throw new QilnInstallerError({
      code: 'LOCAL_CREDENTIAL_TOKEN_MISMATCH',
      check: 'retained NATS and Host credentials',
      summary: 'The retained NATS credentials do not agree.',
      observed: 'The NATS token in nats-server.conf differs from the token in qiln-host.env.',
      reason: 'Qiln cannot determine one authoritative retained NATS authentication value.',
      operatorAction: 'Inspect and recover the complete local credential set manually before retrying.',
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
    })
  }
  await validateGatewayKey(local.gatewayKey, sshKeygen)
  const keys = INSTALLER_SPEC.credentials.keys
  return {
    ...local,
    natsToken,
    cookieSecret: host.cookieSecret,
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
      throw new QilnInstallerError({
        code: 'INSTANCE_CREDENTIAL_NAMESPACE_COLLISION',
        check: 'orchestrator credential namespaces',
        summary: 'The orchestrator contains conflicting text and binary credential keys.',
        observed: `Both credential namespaces are populated for managed suffix '${suffix}'.`,
        reason: 'Incus text and binary systemd credential namespaces are mutually exclusive for a managed suffix.',
        operatorAction:
          'Inspect the stopped orchestrator configuration and recover the intended credential namespace manually.',
        rerun:
          'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
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

async function current(directory: Dir, client: LocalIncusClient): Promise<CurrentInstance> {
  const state = await inspectOpenInstallerState(directory)
  if (!state.installation) {
    throw new QilnInstallerError({
      code: 'INSTALLATION_STATE_REQUIRED',
      check: 'credential delivery installation pin',
      summary: 'The installation image pin is unavailable.',
      observed: 'installation.json is absent after image convergence.',
      reason: 'Credentials may be delivered only to an instance derived from the persisted image identity.',
      operatorAction: 'Rerun qiln up to reconcile the selected image and installation state.',
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
    })
  }
  let instance: IncusRead<IncusInstance> | null
  try {
    instance = await client.getInstanceWithEtagOrNull(INSTALLER_SPEC.orchestrator.name)
  } catch (error: unknown) {
    throw toInstallerError(error, {
      check: 'credential delivery instance inspection',
      operation: 'read the stopped orchestrator instance and its ETag',
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
    })
  }
  if (!instance) {
    throw new QilnInstallerError({
      code: 'ORCHESTRATOR_INSTANCE_REQUIRED',
      check: 'credential delivery instance inspection',
      summary: 'The stopped development orchestrator is unavailable.',
      observed: `Incus did not return '${INSTALLER_SPEC.orchestrator.name}'.`,
      reason: 'Credentials cannot be delivered without an exact compatible stopped target instance.',
      operatorAction: 'Rerun qiln up to reconcile the stopped development orchestrator.',
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
    })
  }
  collision(instance.value.config)
  assertInstance(instance.value, state.installation.imageFingerprint)
  const signature = instance.value.config['volatile.base_image']
  if (
    typeof signature !== 'string' ||
    !FULL_FINGERPRINT_PATTERN.test(signature) ||
    signature !== state.installation.imageFingerprint
  ) {
    throw new QilnInstallerError({
      code: 'ORCHESTRATOR_IMAGE_SIGNATURE_MISMATCH',
      check: 'credential delivery image identity',
      summary: 'The stopped orchestrator does not match the persisted image identity.',
      observed: 'The instance base-image signature is missing, malformed, or different from installation.json.',
      reason: 'Qiln never delivers credentials to an instance created from another image.',
      operatorAction:
        'Remove the incompatible stopped orchestrator manually while preserving its PostgreSQL volume, then rerun qiln up.',
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
    })
  }
  return {
    installation: state.installation,
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
      throw new QilnInstallerError({
        code: 'GATEWAY_HOST_KEY_GENERATION_FAILED',
        check: 'SSH gateway host-key generation',
        summary: 'The SSH gateway host key could not be generated.',
        observed: 'ssh-keygen did not complete successfully in the private temporary directory.',
        reason: 'Qiln cannot configure the SSH gateway without one retained unencrypted Ed25519 host key.',
        operatorAction: 'Inspect the local ssh-keygen installation and rerun qiln up.',
        rerun:
          'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
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

async function generate(directory: Dir, roster: FileSnapshot, sshKeygen: string): Promise<Credentials> {
  const target = await current(directory, argumentsClient)
  if (hasManagedCredentials(target.read.value.config)) {
    throw new QilnInstallerError({
      code: 'LOCAL_CREDENTIAL_RECOVERY_REQUIRED',
      check: 'first credential-set generation',
      summary: 'Managed instance credentials exist without their local source-of-truth files.',
      observed: 'The stopped orchestrator contains one or more managed credential keys while the local set is absent.',
      reason: 'Generating replacements could silently rotate credentials already delivered to the instance.',
      operatorAction:
        'Recover the original four local credential files manually or remove the stopped instance credential state after review.',
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
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
    throw new QilnInstallerError({
      code: 'LOCAL_CREDENTIAL_PERSISTENCE_FAILED',
      check: 'first credential-set persistence',
      summary: 'The generated credential set could not be verified after persistence.',
      observed: 'The protected state directory did not contain a complete valid credential set.',
      reason: 'Qiln delivers credentials only after all four local source-of-truth files are retained and validated.',
      operatorAction: 'Inspect the protected installer state directory manually before retrying.',
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
    })
  }
  return persisted
}

let argumentsClient: LocalIncusClient

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

async function deliver(directory: Dir, client: LocalIncusClient, sshKeygen: string): Promise<Delivery> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const target = await current(directory, client)
    const local = await load(directory, sshKeygen)
    if (local === 'absent') {
      throw new QilnInstallerError({
        code: 'LOCAL_CREDENTIAL_SET_REQUIRED',
        check: 'instance credential delivery',
        summary: 'The complete local credential set is unavailable.',
        observed: 'The protected installer state directory contains no credential set.',
        reason: 'The instance can receive only credentials retained as the local source of truth.',
        operatorAction: 'Supply a valid authorized-key roster and rerun qiln up.',
        rerun:
          'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
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
          rerun:
            'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
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
        throw new QilnInstallerError({
          code: 'INCUS_ETAG_CONFLICT',
          check: 'guarded orchestrator credential delivery',
          summary: 'The orchestrator changed during both guarded update attempts.',
          observed: 'Incus returned HTTP 412 after the instance was re-read and revalidated once.',
          reason: 'Qiln will not continue retrying a secret-bearing complete update against changing provider state.',
          operatorAction: 'Stop concurrent instance configuration changes, then rerun qiln up.',
          rerun:
            'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
          cause: error,
        })
      }
      if (error instanceof IncusApiError) {
        throw toInstallerError(error, {
          check: 'guarded orchestrator credential delivery',
          operation: 'apply the complete stopped instance credential configuration',
          rerun:
            'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
        })
      }
      throw error
    }
  }
  throw new Error('Credential delivery retry state was exhausted unexpectedly.')
}

async function verify(
  directory: Dir,
  client: LocalIncusClient,
  sshKeygen: string,
  expected: IncusInstancePut,
  verifyAlias: boolean,
): Promise<string> {
  const state = await inspectOpenInstallerState(directory)
  if (!state.installation) {
    throw new QilnInstallerError({
      code: 'FINAL_INSTALLATION_STATE_MISSING',
      check: 'final stopped-installation verification',
      summary: 'The persisted installation state is absent.',
      observed: 'installation.json could not be re-read after credential convergence.',
      reason: 'A successful installation requires one authoritative persisted image identity.',
      operatorAction: 'Inspect the protected installer state directory and rerun qiln up.',
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
    })
  }
  const installation = state.installation
  let image
  let network
  let volume
  let instance
  try {
    image = await client.getImage(installation.imageFingerprint)
    network = await client.getNetwork(INSTALLER_SPEC.network.name)
    volume = await client.getStoragePoolVolume(
      INSTALLER_SPEC.storage.poolName,
      INSTALLER_SPEC.storage.volumeType,
      INSTALLER_SPEC.storage.volumeName,
    )
    instance = await client.getInstance(INSTALLER_SPEC.orchestrator.name)
  } catch (error: unknown) {
    throw toInstallerError(error, {
      check: 'final stopped-installation verification',
      operation: 're-read the selected image, network, volume, and stopped orchestrator',
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
    })
  }
  validateContainerImage(image, installation.imageFingerprint)
  assertNetwork(network)
  assertVolume(volume)
  collision(instance.config)
  assertInstance(instance, installation.imageFingerprint)
  const local = await load(directory, sshKeygen)
  if (local === 'absent') {
    throw new QilnInstallerError({
      code: 'FINAL_LOCAL_CREDENTIAL_SET_MISSING',
      check: 'final stopped-installation verification',
      summary: 'The local credential set is absent after convergence.',
      observed: 'The protected installer state directory no longer contains all four credentials.',
      reason: 'Qiln cannot verify delivered credentials without their retained local source of truth.',
      operatorAction: 'Inspect and recover the protected local credential set manually.',
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
    })
  }
  if (!matches(instance.config, local.values)) {
    throw new QilnInstallerError({
      code: 'FINAL_INSTANCE_CREDENTIAL_MISMATCH',
      check: 'final stopped-installation verification',
      summary: 'The stopped orchestrator credentials do not match the retained local credential set.',
      observed: 'At least one managed credential is missing or differs from the local source of truth.',
      reason: 'Qiln reports success only after exact text and binary credential equality is verified.',
      operatorAction: 'Inspect concurrent instance changes and rerun qiln up.',
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
    })
  }
  if (!samePut(instance, expected)) {
    throw new QilnInstallerError({
      code: 'FINAL_INSTANCE_STATE_MISMATCH',
      check: 'final stopped-installation verification',
      summary: 'The stopped orchestrator changed during credential convergence.',
      observed:
        'Profiles, devices, local configuration, or another writable instance field differs from the guarded state.',
      reason: 'Credential delivery must not alter unrelated instance configuration.',
      operatorAction: 'Inspect concurrent instance changes and rerun qiln up.',
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
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
        rerun:
          'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
      })
    }
    if (alias.target !== installation.imageFingerprint) {
      throw new QilnInstallerError({
        code: 'FINAL_IMAGE_ALIAS_MISMATCH',
        check: 'final managed image-alias verification',
        summary: 'The managed image alias no longer identifies the selected image.',
        observed: 'The alias target differs from the persisted full image fingerprint.',
        reason: 'Explicit split-image convergence requires both image and managed alias identity to remain stable.',
        operatorAction: 'Inspect concurrent Incus image changes and rerun qiln up.',
        rerun:
          'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
      })
    }
  }
  return installation.imageFingerprint
}

export async function convergeCredentials(options: {
  directory: Dir
  client: LocalIncusClient
  sshKeygen: string
  roster: FileSnapshot | null
  verifyAlias: boolean
}): Promise<CredentialConvergence> {
  argumentsClient = options.client
  let local = await load(options.directory, options.sshKeygen)
  let localOutcome: LocalOutcome
  if (local === 'absent') {
    if (!options.roster) {
      throw new QilnInstallerError({
        code: 'AUTHORIZED_KEYS_REQUIRED',
        check: 'first credential-set generation',
        summary: '--authorized-keys is required for the first credential set.',
        observed: 'No local credential files or validated authorized-key roster are available.',
        reason: 'Qiln cannot generate a complete first credential set without an explicitly selected SSH roster.',
        operatorAction: 'Pass a valid developer-owned OpenSSH public-key roster with --authorized-keys.',
        rerun:
          'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
      })
    }
    local = await generate(options.directory, options.roster, options.sshKeygen)
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
  const delivery = await deliver(options.directory, options.client, options.sshKeygen)
  const imageFingerprint = await verify(
    options.directory,
    options.client,
    options.sshKeygen,
    delivery.expected,
    options.verifyAlias,
  )
  return {
    localOutcome,
    deliveryOutcome: delivery.outcome,
    imageFingerprint,
  }
}
