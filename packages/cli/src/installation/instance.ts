import { isAbsolute } from 'node:path'
import { InstallerError } from '../diagnostic/error'
import { INSTALLER_SPEC } from './spec'
import type { InstallationInputs } from './types'
import type { Layout } from './layout'
import type { IncusConfigMap, IncusDevicesMap, IncusInstance, IncusInstanceCreate } from '../transport/incus/types'

const STOPPED_STATUS_CODE = 102
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

function validateSourceRoot(sourceRoot: string, retry: string): void {
  if (
    !isAbsolute(sourceRoot) ||
    sourceRoot.trim() !== sourceRoot ||
    sourceRoot === '/' ||
    CONTROL_CHARACTER_PATTERN.test(sourceRoot)
  ) {
    throw new InstallerError({
      code: 'INVALID_SOURCE_ROOT',
      facts: [['Observed', 'The source root is not a canonical absolute non-root path.']],
      retry,
    })
  }
}

function expectedConfig(layout: Layout): IncusConfigMap {
  return {
    ...layout.orchestrator.limits,
    ...INSTALLER_SPEC.orchestrator.config,
  }
}

function expectedDevices({ layout, sourceRoot }: InstallationInputs, retry: string): IncusDevicesMap {
  validateSourceRoot(sourceRoot, retry)
  const { pool, network, postgres, orchestrator } = layout
  return {
    root: {
      type: 'disk',
      pool: pool.name,
      path: '/',
    },
    eth0: {
      type: 'nic',
      name: 'eth0',
      network: network.name,
      'ipv4.address': orchestrator.ipv4Address,
      'security.ipv4_filtering': 'true',
      'security.mac_filtering': 'true',
    },
    'postgres-data': {
      type: 'disk',
      pool: pool.name,
      source: postgres.volumeName,
      path: INSTALLER_SPEC.storage.guestMountPath,
    },
    incus: {
      ...INSTALLER_SPEC.orchestrator.incusDevice,
    },
    [INSTALLER_SPEC.orchestrator.sourceDeviceName]: {
      type: 'disk',
      source: sourceRoot,
      path: INSTALLER_SPEC.orchestrator.sourceMountPath,
      readonly: 'false',
      shift: 'true',
      required: 'true',
    },
  }
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
  inputs: InstallationInputs,
  retry: string,
): {
  missing: string[]
  mismatched: string[]
  unexpected: string[]
} {
  const expected = expectedDevices(inputs, retry)
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

/**
 * The one comparison behind both the boolean and the diagnostic form, so a
 * verification and a refusal can never disagree about compatibility.
 */
function compatibility(instance: IncusInstance, imageFingerprint: string, inputs: InstallationInputs, retry: string) {
  const config = configDifferences(instance.config, expectedConfig(inputs.layout), imageFingerprint)
  const devices = deviceDifferences(instance.devices, inputs, retry)
  const compatible =
    instance.name === INSTALLER_SPEC.orchestrator.name &&
    instance.architecture === inputs.architecture.incus &&
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
  return { config, devices, compatible }
}

export function instanceFits(
  instance: IncusInstance,
  imageFingerprint: string,
  inputs: InstallationInputs,
  retry: string,
): boolean {
  return compatibility(instance, imageFingerprint, inputs, retry).compatible
}

export function assertInstance(
  instance: IncusInstance,
  imageFingerprint: string,
  inputs: InstallationInputs,
  retry: string,
): void {
  const { config, devices, compatible } = compatibility(instance, imageFingerprint, inputs, retry)
  if (compatible) {
    return
  }
  throw new InstallerError({
    code: 'INCOMPATIBLE_ORCHESTRATOR_INSTANCE',
    facts: [
      [
        'Observed',
        `Instance '${instance.name}' reports architecture='${instance.architecture}' (expected '${inputs.architecture.incus}'), type='${instance.type}', status='${instance.status}', status_code=${instance.statusCode}, project='${instance.project || INSTALLER_SPEC.projectName}', ephemeral=${instance.ephemeral}, stateful=${instance.stateful}, and profiles='${instance.profiles.join(',') || 'none'}'; volatile.base_image expected '${imageFingerprint}' but was '${config.baseImage || 'unset'}'; missing or mismatched config keys: ${config.missing.join(', ') || 'none'}; unexpected non-volatile, non-image config keys: ${config.unexpected.join(', ') || 'none'}; missing devices: ${devices.missing.join(', ') || 'none'}; mismatched devices: ${devices.mismatched.join(', ') || 'none'}; unexpected devices: ${devices.unexpected.join(', ') || 'none'}.`,
      ],
    ],
    retry,
  })
}

/**
 * Takes the image fingerprint itself, so an approved plan can create the
 * instance without depending on when the installation pin is written.
 */
export function instanceInput(fingerprint: string, inputs: InstallationInputs, retry: string): IncusInstanceCreate {
  return {
    name: INSTALLER_SPEC.orchestrator.name,
    architecture: inputs.architecture.incus,
    description: INSTALLER_SPEC.orchestrator.description,
    type: INSTALLER_SPEC.orchestrator.type,
    start: INSTALLER_SPEC.orchestrator.start,
    ephemeral: INSTALLER_SPEC.orchestrator.ephemeral,
    stateful: INSTALLER_SPEC.orchestrator.stateful,
    profiles: [...INSTALLER_SPEC.orchestrator.profileNames],
    config: expectedConfig(inputs.layout),
    devices: expectedDevices(inputs, retry),
    source: {
      type: 'image',
      fingerprint,
    },
  }
}
