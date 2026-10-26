import { InstallerError } from '../diagnostic/error'
import { INSTALLER_SPEC } from './spec'
import type { IncusNetwork, IncusNetworkCreate } from '../transport/incus/types'
import type { Layout } from './layout'

function configDifferences(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): {
  missing: string[]
  unexpected: string[]
} {
  const missing = Object.entries(expected)
    .filter(([key, value]) => actual[key] !== value)
    .map(([key]) => key)
  const unexpected = Object.keys(actual).filter(key => !Object.hasOwn(expected, key) && !key.startsWith('volatile.'))
  return {
    missing,
    unexpected,
  }
}

export function assertNetwork(network: IncusNetwork, layout: Layout, retry: string): void {
  const differences = configDifferences(network.config, layout.network.config)
  const compatible =
    network.name === layout.network.name &&
    network.type === INSTALLER_SPEC.network.type &&
    network.description === INSTALLER_SPEC.network.description &&
    network.managed &&
    network.status === 'Created' &&
    (network.project === '' || network.project === INSTALLER_SPEC.projectName) &&
    differences.missing.length === 0 &&
    differences.unexpected.length === 0
  if (compatible) {
    return
  }
  throw new InstallerError({
    code: 'INCOMPATIBLE_INCUS_NETWORK',
    facts: [
      [
        'Observed',
        `Incus reports type='${network.type}', managed=${network.managed}, status='${network.status || 'unknown'}', description='${network.description}', and project='${network.project || INSTALLER_SPEC.projectName}'; missing or mismatched expected keys: ${differences.missing.join(', ') || 'none'}; unexpected non-volatile keys: ${differences.unexpected.join(', ') || 'none'}.`,
      ],
    ],
    retry,
  })
}

export function networkInput(layout: Layout): IncusNetworkCreate {
  return {
    name: layout.network.name,
    type: INSTALLER_SPEC.network.type,
    description: INSTALLER_SPEC.network.description,
    config: {
      ...layout.network.config,
    },
  }
}
