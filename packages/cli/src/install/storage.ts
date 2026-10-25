import { InstallerError } from '../diagnostic/error'
import { isIncusApiStatus, toInstallerError } from '../incus/errors'
import { INSTALLER_SPEC } from './spec'
import type { IncusClient } from '../incus/client'
import type { IncusStorageVolume, IncusStorageVolumeCreate } from '../incus/types'
import type { Layout } from './layout'

const RERUN =
  'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]'

export interface StorageConvergence {
  volume: IncusStorageVolume
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

export function assertVolume(volume: IncusStorageVolume, layout: Layout): void {
  const differences = configDifferences(volume.config, layout.postgres.config)
  const compatible =
    volume.name === layout.postgres.volumeName &&
    volume.type === INSTALLER_SPEC.storage.volumeType &&
    volume.contentType === INSTALLER_SPEC.storage.volumeContentType &&
    volume.description === INSTALLER_SPEC.storage.volumeDescription &&
    (volume.project === '' || volume.project === INSTALLER_SPEC.projectName) &&
    differences.missing.length === 0 &&
    differences.unexpected.length === 0
  if (compatible) {
    return
  }
  throw new InstallerError({
    code: 'INCOMPATIBLE_POSTGRES_VOLUME',
    facts: [
      [
        'Observed',
        `Volume '${volume.name}' reports type='${volume.type}', content_type='${volume.contentType}', description='${volume.description}', and project='${volume.project || INSTALLER_SPEC.projectName}'; missing or mismatched expected keys: ${differences.missing.join(', ') || 'none'}; unexpected non-volatile keys: ${differences.unexpected.join(', ') || 'none'}.`,
      ],
    ],
    retry: 'qiln doctor',
  })
}

async function getVolume(client: IncusClient, layout: Layout): Promise<IncusStorageVolume | null> {
  try {
    return await client.getStoragePoolVolumeOrNull(
      layout.pool.name,
      INSTALLER_SPEC.storage.volumeType,
      layout.postgres.volumeName,
    )
  } catch (error: unknown) {
    throw toInstallerError(error, {
      check: 'Qiln PostgreSQL volume convergence',
      operation: 'inspect the Qiln PostgreSQL custom volume',
      rerun: RERUN,
    })
  }
}

function createInput(layout: Layout): IncusStorageVolumeCreate {
  return {
    name: layout.postgres.volumeName,
    type: INSTALLER_SPEC.storage.volumeType,
    contentType: INSTALLER_SPEC.storage.volumeContentType,
    description: INSTALLER_SPEC.storage.volumeDescription,
    config: {
      ...layout.postgres.config,
    },
    source: {},
  }
}

export async function convergeStorage(client: IncusClient, layout: Layout): Promise<StorageConvergence> {
  const existing = await getVolume(client, layout)
  if (existing) {
    assertVolume(existing, layout)
    return {
      volume: existing,
      outcome: 'reused',
    }
  }
  let created = false
  let conflict: unknown
  try {
    await client.createStoragePoolVolume(layout.pool.name, createInput(layout))
    created = true
  } catch (error: unknown) {
    if (!isIncusApiStatus(error, 409)) {
      throw toInstallerError(error, {
        check: 'Qiln PostgreSQL volume convergence',
        operation: 'create the Qiln PostgreSQL custom volume',
        rerun: RERUN,
      })
    }
    conflict = error
  }
  const volume = await getVolume(client, layout)
  if (!volume) {
    if (conflict !== undefined) {
      throw toInstallerError(conflict, {
        check: 'Qiln PostgreSQL volume convergence',
        operation: 'reconcile the concurrently changed Qiln PostgreSQL custom volume',
        rerun: RERUN,
      })
    }
    throw new InstallerError({
      code: 'POSTGRES_VOLUME_VERIFICATION_FAILED',
      facts: [
        [
          'Observed',
          `Incus did not return '${layout.postgres.volumeName}' after accepting its synchronous creation request.`,
        ],
      ],
      retry: RERUN,
    })
  }
  assertVolume(volume, layout)
  return {
    volume,
    outcome: created ? 'created' : 'reused',
  }
}
