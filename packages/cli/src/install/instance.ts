import { isAbsolute } from 'node:path'
import { QilnInstallerError } from '../error'
import { isIncusApiStatus, toInstallerError } from '../incus/errors'
import { INSTALLER_SPEC } from './spec'
import type { InstallationState } from './state'
import type { LocalIncusClient } from '../incus/client'
import type { IncusDevicesMap, IncusInstance, IncusInstanceCreate } from '../incus/types'

const FULL_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/
const STOPPED_STATUS_CODE = 102
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

export interface InstanceConvergence {
  instance: IncusInstance
  outcome: 'created' | 'reused'
}

function validateSourceRoot(sourceRoot: string): void {
  if (
    !isAbsolute(sourceRoot) ||
    sourceRoot.trim() !== sourceRoot ||
    sourceRoot === '/' ||
    CONTROL_CHARACTER_PATTERN.test(sourceRoot)
  ) {
    throw new QilnInstallerError({
      code: 'INVALID_SOURCE_ROOT',
      check: 'orchestrator source-device path',
      summary: 'The validated Qiln source root cannot be used as an Incus source device.',
      observed: 'The source root is not a canonical absolute non-root path.',
      reason: 'The installer must bind exactly one validated host checkout into the development orchestrator.',
      operatorAction: 'Rerun with the canonical Qiln Git checkout root through --source.',
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
    })
  }
}

function expectedDevices(sourceRoot: string): IncusDevicesMap {
  validateSourceRoot(sourceRoot)
  const devices: IncusDevicesMap = {}
  for (const [name, device] of Object.entries(INSTALLER_SPEC.orchestrator.devices)) {
    devices[name] = {
      ...device,
    }
  }
  devices[INSTALLER_SPEC.orchestrator.sourceDeviceName] = {
    type: 'disk',
    source: sourceRoot,
    path: INSTALLER_SPEC.orchestrator.sourceMountPath,
    readonly: 'false',
    shift: 'true',
    required: 'true',
  }
  return devices
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

function configDifferences(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
  expectedBaseImage: string,
): {
  missing: string[]
  unexpected: string[]
  baseImage: string
  baseImageMatches: boolean
} {
  const missing = Object.entries(expected)
    .filter(([key, value]) => actual[key] !== value)
    .map(([key]) => key)
  const credentialKeys = new Set<string>(INSTALLER_SPEC.orchestrator.credentialKeys)
  const unexpected = Object.keys(actual).filter(
    key =>
      !Object.hasOwn(expected, key) &&
      !key.startsWith('volatile.') &&
      !key.startsWith('image.') &&
      !credentialKeys.has(key),
  )
  const baseImage = actual['volatile.base_image'] ?? ''
  return {
    missing,
    unexpected,
    baseImage,
    baseImageMatches: baseImage === expectedBaseImage,
  }
}

function sameDevice(actual: Readonly<Record<string, string>>, expected: Readonly<Record<string, string>>): boolean {
  const actualKeys = Object.keys(actual).sort()
  const expectedKeys = Object.keys(expected).sort()
  return sameStrings(actualKeys, expectedKeys) && expectedKeys.every(key => actual[key] === expected[key])
}

function deviceDifferences(
  actual: IncusDevicesMap,
  sourceRoot: string,
): {
  missing: string[]
  mismatched: string[]
  unexpected: string[]
} {
  const expected = expectedDevices(sourceRoot)
  const expectedNames = Object.keys(expected)
  const actualNames = Object.keys(actual)
  const missing = expectedNames.filter(name => actual[name] === undefined)
  const unexpected = actualNames.filter(name => expected[name] === undefined)
  const mismatched = expectedNames.filter(name => {
    const actualDevice = actual[name]
    const expectedDevice = expected[name]
    return actualDevice !== undefined && expectedDevice !== undefined && !sameDevice(actualDevice, expectedDevice)
  })
  return {
    missing,
    mismatched,
    unexpected,
  }
}

export function assertInstance(instance: IncusInstance, imageFingerprint: string, sourceRoot: string): void {
  const config = configDifferences(instance.config, INSTALLER_SPEC.orchestrator.config, imageFingerprint)
  const devices = deviceDifferences(instance.devices, sourceRoot)
  const compatible =
    instance.name === INSTALLER_SPEC.orchestrator.name &&
    instance.architecture === INSTALLER_SPEC.orchestrator.architecture &&
    instance.description === INSTALLER_SPEC.orchestrator.description &&
    instance.type === INSTALLER_SPEC.orchestrator.type &&
    instance.status === 'Stopped' &&
    instance.statusCode === STOPPED_STATUS_CODE &&
    (instance.project === '' || instance.project === INSTALLER_SPEC.projectName) &&
    instance.ephemeral === INSTALLER_SPEC.orchestrator.ephemeral &&
    instance.stateful === INSTALLER_SPEC.orchestrator.stateful &&
    sameStrings(instance.profiles, INSTALLER_SPEC.orchestrator.profileNames) &&
    config.missing.length === 0 &&
    config.unexpected.length === 0 &&
    config.baseImageMatches &&
    devices.missing.length === 0 &&
    devices.mismatched.length === 0 &&
    devices.unexpected.length === 0
  if (compatible) {
    return
  }
  throw new QilnInstallerError({
    code: 'INCOMPATIBLE_ORCHESTRATOR_INSTANCE',
    check: 'existing development orchestrator instance',
    summary: 'The existing development orchestrator conflicts with the installer-owned definition.',
    observed: `Instance '${instance.name}' reports architecture='${instance.architecture}', type='${instance.type}', status='${instance.status}', status_code=${instance.statusCode}, project='${instance.project || INSTALLER_SPEC.projectName}', ephemeral=${instance.ephemeral}, stateful=${instance.stateful}, and profiles='${instance.profiles.join(',') || 'none'}'; volatile.base_image expected '${imageFingerprint}' but was '${config.baseImage || 'unset'}'; missing or mismatched config keys: ${config.missing.join(', ') || 'none'}; unexpected non-volatile, non-image config keys: ${config.unexpected.join(', ') || 'none'}; missing devices: ${devices.missing.join(', ') || 'none'}; mismatched devices: ${devices.mismatched.join(', ') || 'none'}; unexpected devices: ${devices.unexpected.join(', ') || 'none'}.`,
    reason:
      'Qiln will not retain an instance created from a different image pin or source checkout, or start, stop, rebuild, delete, or partially repair an incompatible retained orchestrator instance.',
    operatorAction: `Delete only the stopped '${INSTALLER_SPEC.orchestrator.name}' instance manually while preserving '${INSTALLER_SPEC.storage.volumeName}', then rerun qiln up with the intended canonical --source checkout and selected image.`,
    rerun:
      'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
  })
}

function validateState(state: InstallationState): void {
  if (
    state.version !== INSTALLER_SPEC.stateVersion ||
    state.projectName !== INSTALLER_SPEC.projectName ||
    state.instanceName !== INSTALLER_SPEC.orchestrator.name ||
    !FULL_FINGERPRINT_PATTERN.test(state.imageFingerprint)
  ) {
    throw new QilnInstallerError({
      code: 'INVALID_INSTALLATION_STATE',
      check: 'persisted orchestrator image pin',
      summary: 'The persisted installation state cannot be used for instance creation.',
      observed:
        'The state does not contain the required version, project, instance name, and full lowercase image fingerprint.',
      reason: 'The orchestrator may be created only from an image fingerprint already persisted by the installer.',
      operatorAction: 'Reconcile the selected image and installation state before retrying.',
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
    })
  }
}

function createInput(state: InstallationState, sourceRoot: string): IncusInstanceCreate {
  validateState(state)
  return {
    name: INSTALLER_SPEC.orchestrator.name,
    architecture: INSTALLER_SPEC.orchestrator.architecture,
    description: INSTALLER_SPEC.orchestrator.description,
    type: INSTALLER_SPEC.orchestrator.type,
    start: INSTALLER_SPEC.orchestrator.start,
    ephemeral: INSTALLER_SPEC.orchestrator.ephemeral,
    stateful: INSTALLER_SPEC.orchestrator.stateful,
    profiles: [...INSTALLER_SPEC.orchestrator.profileNames],
    config: {
      ...INSTALLER_SPEC.orchestrator.config,
    },
    devices: expectedDevices(sourceRoot),
    source: {
      type: 'image',
      fingerprint: state.imageFingerprint,
    },
  }
}

async function getInstance(client: LocalIncusClient): Promise<IncusInstance | null> {
  try {
    return await client.getInstanceOrNull(INSTALLER_SPEC.orchestrator.name)
  } catch (error: unknown) {
    throw toInstallerError(error, {
      check: 'development orchestrator instance convergence',
      operation: `inspect the '${INSTALLER_SPEC.orchestrator.name}' instance`,
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
    })
  }
}

export async function convergeInstance(
  client: LocalIncusClient,
  state: InstallationState,
  sourceRoot: string,
): Promise<InstanceConvergence> {
  validateState(state)
  validateSourceRoot(sourceRoot)
  const existing = await getInstance(client)
  if (existing) {
    assertInstance(existing, state.imageFingerprint, sourceRoot)
    return {
      instance: existing,
      outcome: 'reused',
    }
  }
  let created = false
  let conflict: unknown
  try {
    const operation = await client.createInstance(createInput(state, sourceRoot))
    await client.waitOperation(operation)
    created = true
  } catch (error: unknown) {
    if (!isIncusApiStatus(error, 409)) {
      throw toInstallerError(error, {
        check: 'development orchestrator instance convergence',
        operation: `create the stopped '${INSTALLER_SPEC.orchestrator.name}' instance`,
        rerun:
          'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
      })
    }
    conflict = error
  }
  const instance = await getInstance(client)
  if (!instance) {
    if (conflict !== undefined) {
      throw toInstallerError(conflict, {
        check: 'development orchestrator instance convergence',
        operation: `reconcile the concurrently changed '${INSTALLER_SPEC.orchestrator.name}' instance`,
        rerun:
          'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
      })
    }
    throw new QilnInstallerError({
      code: 'ORCHESTRATOR_INSTANCE_VERIFICATION_FAILED',
      check: 'development orchestrator instance convergence',
      summary: 'The orchestrator instance is absent after creation.',
      observed: `Incus did not return '${INSTALLER_SPEC.orchestrator.name}' after its creation operation completed successfully.`,
      reason: 'Qiln cannot report a configured installation without re-reading the exact stopped instance.',
      operatorAction: 'Inspect the local Incus instance inventory and operation history manually before retrying.',
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
    })
  }
  assertInstance(instance, state.imageFingerprint, sourceRoot)
  return {
    instance,
    outcome: created ? 'created' : 'reused',
  }
}
