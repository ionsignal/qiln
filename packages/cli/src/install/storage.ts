import { QilnInstallerError } from '../error'
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
  throw new QilnInstallerError({
    code: 'INCOMPATIBLE_POSTGRES_VOLUME',
    check: 'existing Qiln PostgreSQL storage volume',
    summary: 'The existing Qiln PostgreSQL volume conflicts with the installer specification.',
    observed: `Volume '${volume.name}' reports type='${volume.type}', content_type='${volume.contentType}', description='${volume.description}', and project='${volume.project || INSTALLER_SPEC.projectName}'; missing or mismatched expected keys: ${differences.missing.join(', ') || 'none'}; unexpected non-volatile keys: ${differences.unexpected.join(', ') || 'none'}.`,
    reason: 'Qiln never replaces or modifies an incompatible persistent data volume automatically.',
    operatorAction: `Inspect '${INSTALLER_SPEC.storage.volumeName}' in pool '${INSTALLER_SPEC.storage.poolName}' manually. Preserve its data and resolve the naming conflict outside Qiln.`,
    rerun: 'qiln doctor',
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
    throw new QilnInstallerError({
      code: 'POSTGRES_VOLUME_VERIFICATION_FAILED',
      check: 'Qiln PostgreSQL volume convergence',
      summary: 'The PostgreSQL volume is absent after creation.',
      observed: `Incus did not return '${INSTALLER_SPEC.storage.volumeName}' after accepting its synchronous creation request.`,
      reason: 'Qiln cannot attach an unverified persistent storage volume to the orchestrator.',
      operatorAction: 'Inspect the local Incus storage volume inventory and daemon logs manually before retrying.',
      rerun:
        'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]',
    })
  }
  assertVolume(volume)
  return {
    volume,
    outcome: created ? 'created' : 'reused',
  }
}
