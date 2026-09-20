import { InstallerError } from '../diagnostic/error'
import { isIncusApiStatus, toInstallerError } from '../incus/errors'
import { INSTALLER_SPEC } from './spec'
import type { LocalIncusClient } from '../incus/client'
import type { IncusStorageVolume, IncusStorageVolumeCreate } from '../incus/types'

export interface StorageConvergence {
  volume: IncusStorageVolume
  outcome: 'created' | 'reused'
}

function configDifferences(actual: Readonly<Record<string, string>>): {
  missing: string[]
  unexpected: string[]
} {
  const expected = INSTALLER_SPEC.storage.volumeConfig
  const missing = Object.entries(expected)
    .filter(([key, value]) => actual[key] !== value)
    .map(([key]) => key)
  const unexpected = Object.keys(actual).filter(key => !Object.hasOwn(expected, key) && !key.startsWith('volatile.'))
  return {
    missing,
    unexpected,
  }
}

export function assertVolume(volume: IncusStorageVolume): void {
  const differences = configDifferences(volume.config)
  const compatible =
    volume.name === INSTALLER_SPEC.storage.volumeName &&
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
    facts: [['Observed', `Volume '${volume.name}' reports type='${volume.type}', content_type='${volume.contentType}', description='${volume.description}', and project='${volume.project || INSTALLER_SPEC.projectName}'; missing or mismatched expected keys: ${differences.missing.join(', ') || 'none'}; unexpected non-volatile keys: ${differences.unexpected.join(', ') || 'none'}.`]],
    retry: 'qiln doctor',
  })
}

async function getVolume(client: LocalIncusClient): Promise<IncusStorageVolume | null> {
  try {
    return await client.getStoragePoolVolumeOrNull(
      INSTALLER_SPEC.storage.poolName,
      INSTALLER_SPEC.storage.volumeType,
      INSTALLER_SPEC.storage.volumeName,
    )
  } catch (error: unknown) {
    throw toInstallerError(error, {
      check: 'Qiln PostgreSQL volume convergence',
      operation: 'inspect the Qiln PostgreSQL custom volume',
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
    })
  }
}

function createInput(): IncusStorageVolumeCreate {
  return {
    name: INSTALLER_SPEC.storage.volumeName,
    type: INSTALLER_SPEC.storage.volumeType,
    contentType: INSTALLER_SPEC.storage.volumeContentType,
    description: INSTALLER_SPEC.storage.volumeDescription,
    config: {
      ...INSTALLER_SPEC.storage.volumeConfig,
    },
    source: {},
  }
}

export async function convergeStorage(client: LocalIncusClient): Promise<StorageConvergence> {
  const existing = await getVolume(client)
  if (existing) {
    assertVolume(existing)
    return {
      volume: existing,
      outcome: 'reused',
    }
  }
  let created = false
  let conflict: unknown
  try {
    await client.createStoragePoolVolume(INSTALLER_SPEC.storage.poolName, createInput())
    created = true
  } catch (error: unknown) {
    if (!isIncusApiStatus(error, 409)) {
      throw toInstallerError(error, {
        check: 'Qiln PostgreSQL volume convergence',
        operation: 'create the Qiln PostgreSQL custom volume',
        rerun:
          'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
      })
    }
    conflict = error
  }
  const volume = await getVolume(client)
  if (!volume) {
    if (conflict !== undefined) {
      throw toInstallerError(conflict, {
        check: 'Qiln PostgreSQL volume convergence',
        operation: 'reconcile the concurrently changed Qiln PostgreSQL custom volume',
        rerun:
          'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
      })
    }
    throw new InstallerError({
      code: 'POSTGRES_VOLUME_VERIFICATION_FAILED',
      facts: [['Observed', `Incus did not return '${INSTALLER_SPEC.storage.volumeName}' after accepting its synchronous creation request.`]],
      retry: 'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
    })
  }
  assertVolume(volume)
  return {
    volume,
    outcome: created ? 'created' : 'reused',
  }
}
