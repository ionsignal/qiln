import { hasCollision, matchesValues } from './credentials'
import { instanceFits, publishedFits } from './instance'
import { delivery, type Observation } from './observe'
import type { InstallationInputs } from './types'
import type { InstallAction, ConfigurePlan } from './journal/types'
import type { IncusInstance } from '../transport/incus/types'

/**
 * An instance step is verified only when the instance is compatible and holds
 * the expected published ports, not merely present.
 */
function compatible(
  instance: IncusInstance,
  fingerprint: string,
  inputs: InstallationInputs,
  retry: string,
): boolean {
  return (
    !hasCollision(instance.config) &&
    instanceFits(instance, fingerprint, inputs, retry) &&
    publishedFits(instance, inputs)
  )
}

/**
 * Pure check of one step's approved result against a fresh observation. A step
 * is verified only when the target agrees, never because its request was
 * accepted. An imported image is only present here: its type and architecture
 * are judged by `requireContainer` right after the import, before any alias,
 * pin, or deletion. A materialized checkout is only present here: its identity
 * was judged by the observation itself, and its HEAD is never compared with
 * anything. An instance update is verified against the ingress its approval
 * named, so a later certificate or endpoint never verifies an earlier update.
 * Compatibility of the whole installation is judged by planning again after the
 * last step.
 */
export function verify(
  action: InstallAction,
  plan: ConfigurePlan,
  observation: Observation,
  inputs: InstallationInputs,
  retry: string,
): boolean {
  const { image, alias, network, volume, instance, checkout, ingress } = observation
  switch (action) {
    case 'materialize-checkout':
      return checkout.kind === 'present'
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
    case 'update-instance': {
      const values = delivery(observation)
      return (
        instance !== null &&
        compatible(instance.value, plan.fingerprint, inputs, retry) &&
        ingress?.digest === plan.ingress &&
        values !== null &&
        matchesValues(instance.value.config, values)
      )
    }
  }
}
