import { InstallerError } from '../diagnostic/error'
import { isIncusApiStatus, toInstallerError } from '../incus/errors'
import { INSTALLER_SPEC } from './spec'
import type { IncusClient } from '../incus/client'
import type { IncusNetwork, IncusNetworkCreate } from '../incus/types'
import type { Layout } from './layout'

const RERUN =
  'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]'

export interface NetworkConvergence {
  network: IncusNetwork
  outcome: 'created' | 'reused'
}

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

export function assertNetwork(network: IncusNetwork, layout: Layout): void {
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
    retry: 'qiln doctor',
  })
}

async function getNetwork(client: IncusClient, layout: Layout): Promise<IncusNetwork | null> {
  try {
    return await client.getNetworkOrNull(layout.network.name)
  } catch (error: unknown) {
    throw toInstallerError(error, {
      check: 'managed Incus network convergence',
      operation: `inspect the '${layout.network.name}' network`,
      rerun: RERUN,
    })
  }
}

function createInput(layout: Layout): IncusNetworkCreate {
  return {
    name: layout.network.name,
    type: INSTALLER_SPEC.network.type,
    description: INSTALLER_SPEC.network.description,
    config: {
      ...layout.network.config,
    },
  }
}

export async function convergeNetwork(client: IncusClient, layout: Layout): Promise<NetworkConvergence> {
  const existing = await getNetwork(client, layout)
  if (existing) {
    assertNetwork(existing, layout)
    return {
      network: existing,
      outcome: 'reused',
    }
  }
  let created = false
  let conflict: unknown
  try {
    await client.createNetwork(createInput(layout))
    created = true
  } catch (error: unknown) {
    if (!isIncusApiStatus(error, 409)) {
      throw toInstallerError(error, {
        check: 'managed Incus network convergence',
        operation: `create the '${layout.network.name}' managed bridge network`,
        rerun: RERUN,
      })
    }
    conflict = error
  }
  const network = await getNetwork(client, layout)
  if (!network) {
    if (conflict !== undefined) {
      throw toInstallerError(conflict, {
        check: 'managed Incus network convergence',
        operation: `reconcile the concurrently changed '${layout.network.name}' network`,
        rerun: RERUN,
      })
    }
    throw new InstallerError({
      code: 'INCUS_NETWORK_VERIFICATION_FAILED',
      facts: [
        [
          'Observed',
          `Incus did not return '${layout.network.name}' after accepting its synchronous creation request.`,
        ],
      ],
      retry: RERUN,
    })
  }
  assertNetwork(network, layout)
  return {
    network,
    outcome: created ? 'created' : 'reused',
  }
}
