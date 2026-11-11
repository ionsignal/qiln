import { assertVolume } from './storage'
import { assertNetwork } from './network'
import { delivery, type Observation } from './observe'
import { assertInstance, publishedFits } from './instance'
import { checkoutPlanOf } from './checkout/judge'
import { InstallerError } from '../diagnostic/error'
import { hasManagedCredentials, matchesValues, requireNoCollision } from './credentials'
import { isImageFingerprint, validateContainerImage } from './preflight/image'
import type { Retry } from './retry'
import type { InstallationInputs } from './types'
import type { FileSnapshot } from '../state/files'
import type { ConfigurePlan } from './journal/types'
import type { IncusImage, IncusImageAlias } from '../transport/incus/types'

export type ImageReplacement = NonNullable<ConfigurePlan['image']['replace']>

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
 * Judges the selected content, when the store holds it, as a container image
 * for the target architecture. Planning applies it to every observation, and the
 * configurer applies it right after an import, before any alias, pin, or
 * deletion. Content that does not fit stays in the image store without an alias.
 * Qiln never deletes it, so the diagnostic tells the operator to.
 */
export function requireContainer(
  { image, fingerprint }: Observation,
  inputs: InstallationInputs,
  retry: string,
): void {
  if (image === null) {
    return
  }
  try {
    validateContainerImage(image, fingerprint, inputs.architecture, retry)
  } catch (error: unknown) {
    if (!(error instanceof InstallerError)) {
      throw error
    }
    throw new InstallerError({
      code: error.code,
      facts: [
        ...error.facts,
        [
          'Imported image',
          `${fingerprint} remains in the Incus image store without an alias. No previous image was deleted for it, and Qiln never deletes it: remove it manually.`,
        ],
      ],
      retry: error.retry,
    })
  }
}

/**
 * Identical content is never replaced. New content is imported without an
 * alias, and the previous target is deleted only after the imported image is
 * checked.
 */
function imagePlan(observation: Observation, inputs: InstallationInputs, retry: string): ConfigurePlan['image'] {
  const { kind, fingerprint, image, alias, aliased } = observation
  if (kind === 'reference') {
    return { replace: null, import: false, alias: false }
  }
  requireContainer(observation, inputs, retry)
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
 * Published port drift is not an incompatibility: it only sets `publish`. The
 * ingress digest binds the approval to the generated configuration, and an
 * ingress that is not derivable yet only sets `deliver`.
 */
export function planOf(observation: Observation, request: PlanRequest): ConfigurePlan {
  const { inputs, roster, retry } = request
  const { layout } = inputs
  const { fingerprint, pin, network, volume, instance } = observation
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
  const values = delivery(observation)
  return {
    kind: 'configure',
    fingerprint,
    checkout: checkoutPlanOf(observation.checkout, retry.configure),
    image: imagePlan(observation, inputs, retry.configure),
    pin: pin !== fingerprint,
    network: network === null,
    volume: volume === null,
    instance: instance === null,
    publish: instance !== null && !publishedFits(instance.value, inputs),
    credentials: mode,
    ingress: observation.ingress?.digest ?? null,
    deliver: instance === null || values === null || mode !== 'reuse' || !matchesValues(instance.value.config, values),
  }
}

/**
 * Replacing the managed image is approved in two gates. The first only adds
 * (the checkout clone and the unaliased import), so a rejected image costs
 * nothing, and deleting the previous image waits until the imported one passed
 * its check. Null means a single gate covers the plan.
 */
export function firstGate(plan: ConfigurePlan): ConfigurePlan | null {
  if (plan.image.replace === null || !plan.image.import) {
    return null
  }
  return {
    kind: 'configure',
    fingerprint: plan.fingerprint,
    checkout: plan.checkout,
    image: { replace: null, import: true, alias: false },
    pin: false,
    network: false,
    volume: false,
    instance: false,
    publish: false,
    credentials: 'reuse',
    ingress: null,
    deliver: false,
  }
}
