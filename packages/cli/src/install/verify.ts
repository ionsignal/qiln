import { matchesCredentials } from './credentials'
import type { InstallAction, ConfigurePlan } from './journal/types'
import type { Observation } from './observe'

/**
 * Pure check of one step's approved result against a fresh observation. A step
 * is verified only when the target agrees, never because its request was
 * accepted. Compatibility of the whole installation is judged by planning
 * again after the last step.
 */
export function verify(action: InstallAction, plan: ConfigurePlan, observation: Observation): boolean {
  const { image, alias, network, volume, instance, credentials } = observation
  switch (action) {
    case 'delete-image':
      return plan.image.replace !== null && (alias === null || alias.target !== plan.image.replace.fingerprint)
    case 'import-image':
      return image?.fingerprint === plan.fingerprint && alias?.target === plan.fingerprint
    case 'create-alias':
      return alias?.target === plan.fingerprint
    case 'create-network':
      return network !== null
    case 'create-volume':
      return volume !== null
    case 'create-instance':
      return instance !== null
    case 'update-instance':
      return instance !== null && credentials !== 'absent' && matchesCredentials(instance.value.config, credentials.values)
  }
}
