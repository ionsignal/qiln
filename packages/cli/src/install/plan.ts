import { isImageFingerprint, validateContainerImage } from '../checks/image'
import { InstallerError } from '../diagnostic/error'
import { hasManagedCredentials, matchesCredentials, requireNoCollision } from './credentials'
import { assertInstance } from './instance'
import { assertNetwork } from './network'
import { assertVolume } from './storage'
import type { IncusImage, IncusImageAlias } from '../incus/types'
import type { Retry } from '../retry'
import type { FileSnapshot } from '../state/files'
import type { ConfigurePlan } from './journal/types'
import type { Observation } from './observe'
import type { InstallationInputs } from './types'

export interface PlanRequest {
  inputs: InstallationInputs
  roster: FileSnapshot | null
  retry: Retry
}

/**
 * The image the managed alias targets must be a full fingerprint that Incus
 * still holds, because a replacement names it and its aliases for approval.
 */
function managedTarget(alias: IncusImageAlias, aliased: IncusImage | null, retry: string): IncusImage {
  if (!isImageFingerprint(alias.target)) {
    throw new InstallerError({
      code: 'MANAGED_IMAGE_ALIAS_TARGET_INVALID',
      facts: [['Observed', `Alias '${alias.name}' targets '${alias.target}'.`]],
      retry,
    })
  }
  if (aliased === null || aliased.fingerprint !== alias.target) {
    throw new InstallerError({
      code: 'MANAGED_IMAGE_ALIAS_TARGET_MISSING',
      facts: [
        ['Observed', `Alias '${alias.name}' targets '${alias.target}', but that full image could not be validated.`],
      ],
      retry,
    })
  }
  return aliased
}

/**
 * Identical content is never replaced. Content that is not in the store is
 * imported without an alias, and the configurer checks it before the previous
 * target is deleted. The managed alias is then pointed at the selected image.
 */
function imagePlan(observation: Observation, inputs: InstallationInputs, retry: string): ConfigurePlan['image'] {
  const { kind, fingerprint, image, alias, aliased } = observation
  if (kind === 'reference') {
    return { replace: null, import: false, alias: false }
  }
  if (image !== null) {
    validateContainerImage(image, fingerprint, inputs.architecture, retry)
  }
  if (alias === null) {
    return { replace: null, import: image === null, alias: true }
  }
  const target = managedTarget(alias, aliased, retry)
  if (alias.target === fingerprint) {
    return { replace: null, import: false, alias: false }
  }
  return {
    replace: { fingerprint: target.fingerprint, aliases: target.aliases },
    import: image === null,
    alias: true,
  }
}

function credentialsPlan(
  observation: Observation,
  roster: FileSnapshot | null,
  retry: string,
): ConfigurePlan['credentials'] {
  const { credentials, instance } = observation
  if (credentials !== 'absent') {
    return roster !== null && !Buffer.from(roster.bytes).equals(credentials.authorizedKeys.bytes) ? 'roster' : 'reuse'
  }
  if (roster === null) {
    throw new InstallerError({
      code: 'AUTHORIZED_KEYS_REQUIRED',
      facts: [['Observed', 'No local credential files or validated authorized-key roster are available.']],
      retry,
    })
  }
  if (instance !== null && hasManagedCredentials(instance.value.config)) {
    throw new InstallerError({
      code: 'LOCAL_CREDENTIAL_RECOVERY_REQUIRED',
      facts: [
        [
          'Observed',
          'The stopped orchestrator contains one or more managed credential keys while the local set is absent.',
        ],
      ],
      retry,
    })
  }
  return 'generate'
}

/**
 * Pure decision over one observation. Every incompatibility with retained
 * state throws before a plan exists, so nothing is deleted for a plan that
 * could not complete. An empty plan means the installation already matches.
 */
export function planOf(observation: Observation, request: PlanRequest): ConfigurePlan {
  const { inputs, roster, retry } = request
  const { layout } = inputs
  const { fingerprint, pin, network, volume, instance, credentials } = observation
  if (network !== null) {
    assertNetwork(network, layout, retry.inspect)
  }
  if (volume !== null) {
    assertVolume(volume, layout, retry.inspect)
  }
  if (instance !== null) {
    requireNoCollision(instance.value.config, retry.configure)
    assertInstance(instance.value, fingerprint, inputs, retry.configure)
  }
  const mode = credentialsPlan(observation, roster, retry.configure)
  return {
    kind: 'configure',
    fingerprint,
    image: imagePlan(observation, inputs, retry.configure),
    pin: pin !== fingerprint,
    network: network === null,
    volume: volume === null,
    instance: instance === null,
    credentials: mode,
    deliver:
      instance === null ||
      credentials === 'absent' ||
      mode !== 'reuse' ||
      !matchesCredentials(instance.value.config, credentials.values),
  }
}
