import { validateContainerImage } from '../checks/image'
import { InstallerError } from '../diagnostic/error'
import { hasManagedCredentials, matchesCredentials, requireNoCollision } from './credentials'
import { assertInstance } from './instance'
import { assertNetwork } from './network'
import { assertVolume } from './storage'
import type { IncusImage, IncusImageAlias } from '../incus/types'
import type { FileSnapshot } from '../state/files'
import type { ConfigurePlan } from './journal/types'
import type { Observation } from './observe'
import type { InstallationInputs } from './types'

const FULL_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/
const RERUN =
  'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]'

export interface PlanRequest {
  inputs: InstallationInputs
  roster: FileSnapshot | null
}

/**
 * The image the managed alias targets must be a full fingerprint that Incus
 * still holds, because a replacement names it and its aliases for approval.
 */
function managedTarget(alias: IncusImageAlias, aliased: IncusImage | null): IncusImage {
  if (!FULL_FINGERPRINT_PATTERN.test(alias.target)) {
    throw new InstallerError({
      code: 'MANAGED_IMAGE_ALIAS_TARGET_INVALID',
      facts: [['Observed', `Alias '${alias.name}' targets '${alias.target}'.`]],
      retry: RERUN,
    })
  }
  if (aliased === null || aliased.fingerprint !== alias.target) {
    throw new InstallerError({
      code: 'MANAGED_IMAGE_ALIAS_TARGET_MISSING',
      facts: [
        ['Observed', `Alias '${alias.name}' targets '${alias.target}', but that full image could not be validated.`],
      ],
      retry: RERUN,
    })
  }
  return aliased
}

/**
 * Identical content is never replaced. Only an alias that targets different
 * content deletes an image, and then the selected content is imported, or
 * aliased when the store already holds it.
 */
function imagePlan(observation: Observation, inputs: InstallationInputs): ConfigurePlan['image'] {
  const { kind, fingerprint, image, alias, aliased } = observation
  if (kind === 'reference') {
    return { replace: null, import: false, alias: false }
  }
  if (image !== null) {
    validateContainerImage(image, fingerprint, inputs.architecture)
  }
  if (alias === null) {
    return { replace: null, import: image === null, alias: image !== null }
  }
  const target = managedTarget(alias, aliased)
  if (alias.target === fingerprint) {
    return { replace: null, import: false, alias: false }
  }
  return {
    replace: { fingerprint: target.fingerprint, aliases: target.aliases },
    import: image === null,
    alias: image !== null,
  }
}

function credentialsPlan(observation: Observation, roster: FileSnapshot | null): ConfigurePlan['credentials'] {
  const { credentials, instance } = observation
  if (credentials !== 'absent') {
    return roster !== null && !Buffer.from(roster.bytes).equals(credentials.authorizedKeys.bytes) ? 'roster' : 'reuse'
  }
  if (roster === null) {
    throw new InstallerError({
      code: 'AUTHORIZED_KEYS_REQUIRED',
      facts: [['Observed', 'No local credential files or validated authorized-key roster are available.']],
      retry: RERUN,
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
      retry: RERUN,
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
  const { inputs, roster } = request
  const { layout } = inputs
  const { fingerprint, pin, network, volume, instance, credentials } = observation
  if (network !== null) {
    assertNetwork(network, layout)
  }
  if (volume !== null) {
    assertVolume(volume, layout)
  }
  if (instance !== null) {
    requireNoCollision(instance.value.config)
    assertInstance(instance.value, fingerprint, inputs)
  }
  const mode = credentialsPlan(observation, roster)
  return {
    kind: 'configure',
    fingerprint,
    image: imagePlan(observation, inputs),
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
