import { QilnInstallerError } from '../error'
import { isIncusApiStatus, toInstallerError } from '../incus/errors'
import { INSTALLER_SPEC } from './spec'
import type { LocalIncusClient } from '../incus/client'
import type { IncusNetwork, IncusNetworkCreate } from '../incus/types'

const RERUN =
  'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]'

export interface NetworkConvergence {
  network: IncusNetwork
  outcome: 'created' | 'reused'
}

function configDifferences(actual: Readonly<Record<string, string>>): {
  missing: string[]
  unexpected: string[]
} {
  const expected = INSTALLER_SPEC.network.config
  const missing = Object.entries(expected)
    .filter(([key, value]) => actual[key] !== value)
    .map(([key]) => key)
  const unexpected = Object.keys(actual).filter(key => !Object.hasOwn(expected, key) && !key.startsWith('volatile.'))
  return {
    missing,
    unexpected,
  }
}

export function assertNetwork(network: IncusNetwork): void {
  const differences = configDifferences(network.config)
  const compatible =
    network.name === INSTALLER_SPEC.network.name &&
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
  throw new QilnInstallerError({
    code: 'INCOMPATIBLE_INCUS_NETWORK',
    check: `existing ${INSTALLER_SPEC.network.name} compatibility`,
    summary: `The existing network '${INSTALLER_SPEC.network.name}' conflicts with the Qiln installer specification.`,
    observed: `Incus reports type='${network.type}', managed=${network.managed}, status='${network.status || 'unknown'}', description='${network.description}', and project='${network.project || INSTALLER_SPEC.projectName}'; missing or mismatched expected keys: ${differences.missing.join(', ') || 'none'}; unexpected non-volatile keys: ${differences.unexpected.join(', ') || 'none'}.`,
    reason:
      'Qiln does not overwrite or partially repair an existing network with conflicting ownership or configuration.',
    operatorAction: `Inspect '${INSTALLER_SPEC.network.name}' manually. Preserve unrelated workloads and resolve the naming or address conflict outside Qiln.`,
    rerun: 'qiln doctor',
  })
}

async function getNetwork(client: LocalIncusClient): Promise<IncusNetwork | null> {
  try {
    return await client.getNetworkOrNull(INSTALLER_SPEC.network.name)
  } catch (error: unknown) {
    throw toInstallerError(error, {
      check: 'managed Incus network convergence',
      operation: `inspect the '${INSTALLER_SPEC.network.name}' network`,
      rerun: RERUN,
    })
  }
}

function createInput(): IncusNetworkCreate {
  return {
    name: INSTALLER_SPEC.network.name,
    type: INSTALLER_SPEC.network.type,
    description: INSTALLER_SPEC.network.description,
    config: {
      ...INSTALLER_SPEC.network.config,
    },
  }
}

export async function convergeNetwork(client: LocalIncusClient): Promise<NetworkConvergence> {
  const existing = await getNetwork(client)
  if (existing) {
    assertNetwork(existing)
    return {
      network: existing,
      outcome: 'reused',
    }
  }
  let created = false
  let conflict: unknown
  try {
    await client.createNetwork(createInput())
    created = true
  } catch (error: unknown) {
    if (!isIncusApiStatus(error, 409)) {
      throw toInstallerError(error, {
        check: 'managed Incus network convergence',
        operation: `create the '${INSTALLER_SPEC.network.name}' managed bridge network`,
        rerun: RERUN,
      })
    }
    conflict = error
  }
  const network = await getNetwork(client)
  if (!network) {
    if (conflict !== undefined) {
      throw toInstallerError(conflict, {
        check: 'managed Incus network convergence',
        operation: `reconcile the concurrently changed '${INSTALLER_SPEC.network.name}' network`,
        rerun: RERUN,
      })
    }
    throw new QilnInstallerError({
      code: 'INCUS_NETWORK_VERIFICATION_FAILED',
      check: 'managed Incus network convergence',
      summary: 'The managed bridge network is absent after creation.',
      observed: `Incus did not return '${INSTALLER_SPEC.network.name}' after accepting its synchronous creation request.`,
      reason: 'Qiln cannot create the orchestrator against an unverified network.',
      operatorAction: 'Inspect the local Incus network inventory and daemon logs manually before retrying.',
      rerun: RERUN,
    })
  }
  assertNetwork(network)
  return {
    network,
    outcome: created ? 'created' : 'reused',
  }
}
