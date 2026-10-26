import { hasCollision, matchesCredentials } from './credentials'
import { instanceFits } from './instance'
import type { IncusInstance } from '../incus/types'
import type { InstallAction, ConfigurePlan } from './journal/types'
import type { Observation } from './observe'
import type { InstallationInputs } from './types'

/**
 * An instance step is verified only when the instance is compatible, not
 * merely present.
 */
function compatible(
  instance: IncusInstance,
  fingerprint: string,
  inputs: InstallationInputs,
  retry: string,
): boolean {
  return !hasCollision(instance.config) && instanceFits(instance, fingerprint, inputs, retry)
}

/**
 * Pure check of one step's approved result against a fresh observation. A step
 * is verified only when the target agrees, never because its request was
 * accepted. An imported image is only present here: its type and architecture
 * are judged by the configurer before anything is deleted. Compatibility of
 * the whole installation is judged by planning again after the last step.
 */
export function verify(
  action: InstallAction,
  plan: ConfigurePlan,
  observation: Observation,
  inputs: InstallationInputs,
  retry: string,
): boolean {
  const { image, alias, network, volume, instance, credentials } = observation
  switch (action) {
    case 'delete-image':
      return plan.image.replace !== null && (alias === null || alias.target !== plan.image.replace.fingerprint)
    case 'import-image':
      return image?.fingerprint === plan.fingerprint
    case 'create-alias':
      return alias?.target === plan.fingerprint
    case 'create-network':
      return network !== null
    case 'create-volume':
      return volume !== null
    case 'create-instance':
      return instance !== null && compatible(instance.value, plan.fingerprint, inputs, retry)
    case 'update-instance':
      return (
        instance !== null &&
        compatible(instance.value, plan.fingerprint, inputs, retry) &&
        credentials !== 'absent' &&
        matchesCredentials(instance.value.config, credentials.values)
      )
  }
}
