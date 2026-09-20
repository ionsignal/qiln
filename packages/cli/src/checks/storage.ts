import { InstallerError } from '../diagnostic/error'
import { INSTALLER_SPEC } from '../install/spec'
import { assertVolume } from '../install/storage'
import { runProcess } from '../process'
import { toInstallerError } from '../incus/errors'
import type { LocalIncusClient } from '../incus/client'
import type { HostPreflight } from './host'
import type { IncusStoragePool, IncusStorageVolume } from '../incus/types'

export interface StoragePreflight {
  hostPoolHealth: string
  incusPool: IncusStoragePool
  existingPostgresVolume: IncusStorageVolume | null
}

export async function validateStoragePreflight(
  host: HostPreflight,
  client: LocalIncusClient,
): Promise<StoragePreflight> {
  const hostPool = await runProcess(host.commandPaths.zpool, [
    'list',
    '-H',
    '-o',
    'name,health',
    INSTALLER_SPEC.storage.poolName,
  ])
  if (hostPool.exitCode !== 0) {
    throw new InstallerError({
      code: 'HOST_ZFS_POOL_MISSING',
      facts: [['Observed', `zpool list could not find or inspect '${INSTALLER_SPEC.storage.poolName}'.`]],
      retry: 'qiln doctor',
    })
  }
  const [hostPoolName, hostPoolHealth] = hostPool.stdout.trim().split(/\s+/)
  if (hostPoolName !== INSTALLER_SPEC.storage.poolName || hostPoolHealth !== 'ONLINE') {
    throw new InstallerError({
      code: 'HOST_ZFS_POOL_UNHEALTHY',
      facts: [['Observed', `zpool reports name='${hostPoolName || 'unknown'}' and health='${hostPoolHealth || 'unknown'}'.`]],
      retry: 'qiln doctor',
    })
  }
  const hostDataset = await runProcess(host.commandPaths.zfs, [
    'list',
    '-H',
    '-o',
    'name',
    INSTALLER_SPEC.storage.poolName,
  ])
  if (hostDataset.exitCode !== 0 || hostDataset.stdout.trim() !== INSTALLER_SPEC.storage.poolName) {
    throw new InstallerError({
      code: 'HOST_ZFS_DATASET_UNAVAILABLE',
      facts: [['Observed', `zfs list did not return the expected '${INSTALLER_SPEC.storage.poolName}' dataset.`]],
      retry: 'qiln doctor',
    })
  }
  let incusPool: IncusStoragePool | null
  try {
    incusPool = await client.getStoragePoolOrNull(INSTALLER_SPEC.storage.poolName)
  } catch (error: unknown) {
    throw toInstallerError(error, {
      check: 'existing Incus storage pool',
      operation: `inspect the '${INSTALLER_SPEC.storage.poolName}' storage pool`,
      rerun: 'qiln doctor',
    })
  }
  if (!incusPool) {
    throw new InstallerError({
      code: 'INCUS_STORAGE_POOL_MISSING',
      facts: [['Observed', `GET /1.0/storage-pools/${INSTALLER_SPEC.storage.poolName} returned not found.`]],
      retry: 'qiln doctor',
    })
  }
  const incusPoolCompatible =
    incusPool.name === INSTALLER_SPEC.storage.poolName &&
    incusPool.driver === INSTALLER_SPEC.storage.driver &&
    incusPool.status === 'Created' &&
    incusPool.config.source === INSTALLER_SPEC.storage.poolName
  if (!incusPoolCompatible) {
    throw new InstallerError({
      code: 'INCOMPATIBLE_INCUS_STORAGE_POOL',
      facts: [['Observed', `Incus reports driver='${incusPool.driver}', status='${incusPool.status || 'unknown'}', and source='${incusPool.config.source ?? 'unset'}'.`]],
      retry: 'qiln doctor',
    })
  }
  let existingPostgresVolume: IncusStorageVolume | null
  try {
    existingPostgresVolume = await client.getStoragePoolVolumeOrNull(
      INSTALLER_SPEC.storage.poolName,
      INSTALLER_SPEC.storage.volumeType,
      INSTALLER_SPEC.storage.volumeName,
    )
  } catch (error: unknown) {
    throw toInstallerError(error, {
      check: 'existing Qiln PostgreSQL storage volume',
      operation: 'inspect the existing Qiln PostgreSQL storage volume',
      rerun: 'qiln doctor',
    })
  }
  if (existingPostgresVolume) {
    assertVolume(existingPostgresVolume)
  }
  return {
    hostPoolHealth,
    incusPool,
    existingPostgresVolume,
  }
}
