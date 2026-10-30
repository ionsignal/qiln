import { InstallerError } from '../../diagnostic/error'
import { INSTALLER_SPEC } from '../spec'
import { assertVolume } from '../storage'
import { runProcess } from '../../transport/process'
import { toInstallerError } from '../../transport/incus/errors'
import type { Layout } from '../layout'
import type { IncusClient } from '../../transport/incus/client'
import type { HostPreflight } from './host'
import type { IncusStoragePool, IncusStorageVolume } from '../../transport/incus/types'

export interface IncusStoragePreflight {
  incusPool: IncusStoragePool
  existingPostgresVolume: IncusStorageVolume | null
}

export interface StoragePreflight extends IncusStoragePreflight {
  hostPoolHealth: string
}

/**
 * The Incus-API half of the storage check, shared by every target: the layout's
 * pool must exist and be compatible, and an existing PostgreSQL volume must be
 * compatible. The pool's source is the layout's dataset when it names one, and
 * otherwise the whole pool of the same name.
 */
export async function validateIncusStorage(
  client: IncusClient,
  layout: Layout,
  retry: string,
): Promise<IncusStoragePreflight> {
  const poolName = layout.pool.name
  const source = layout.pool.source ?? poolName
  let incusPool: IncusStoragePool | null
  try {
    incusPool = await client.getStoragePoolOrNull(poolName)
  } catch (error: unknown) {
    throw toInstallerError(error, {
      check: 'existing Incus storage pool',
      operation: `inspect the '${poolName}' storage pool`,
      rerun: retry,
    })
  }
  if (!incusPool) {
    throw new InstallerError({
      code: 'INCUS_STORAGE_POOL_MISSING',
      facts: [['Observed', `GET /1.0/storage-pools/${poolName} returned not found.`]],
      retry,
    })
  }
  const incusPoolCompatible =
    incusPool.name === poolName &&
    incusPool.driver === INSTALLER_SPEC.storage.driver &&
    incusPool.status === 'Created' &&
    incusPool.config.source === source
  if (!incusPoolCompatible) {
    throw new InstallerError({
      code: 'INCOMPATIBLE_INCUS_STORAGE_POOL',
      facts: [
        [
          'Observed',
          `Incus reports driver='${incusPool.driver}', status='${incusPool.status || 'unknown'}', and source='${incusPool.config.source ?? 'unset'}' (expected source '${source}').`,
        ],
      ],
      retry,
    })
  }
  let existingPostgresVolume: IncusStorageVolume | null
  try {
    existingPostgresVolume = await client.getStoragePoolVolumeOrNull(
      poolName,
      INSTALLER_SPEC.storage.volumeType,
      layout.postgres.volumeName,
    )
  } catch (error: unknown) {
    throw toInstallerError(error, {
      check: 'existing Qiln PostgreSQL storage volume',
      operation: 'inspect the existing Qiln PostgreSQL storage volume',
      rerun: retry,
    })
  }
  if (existingPostgresVolume) {
    assertVolume(existingPostgresVolume, layout, retry)
  }
  return {
    incusPool,
    existingPostgresVolume,
  }
}

/**
 * The local check: this machine's ZFS pool first, then the shared Incus half.
 */
export async function validateStoragePreflight(
  host: HostPreflight,
  client: IncusClient,
  layout: Layout,
  retry: string,
): Promise<StoragePreflight> {
  const poolName = layout.pool.name
  const hostPool = await runProcess(host.commandPaths.zpool, ['list', '-H', '-o', 'name,health', poolName])
  if (hostPool.exitCode !== 0) {
    throw new InstallerError({
      code: 'HOST_ZFS_POOL_MISSING',
      facts: [['Observed', `zpool list could not find or inspect '${poolName}'.`]],
      retry,
    })
  }
  const [hostPoolName, hostPoolHealth] = hostPool.stdout.trim().split(/\s+/)
  if (hostPoolName !== poolName || hostPoolHealth !== 'ONLINE') {
    throw new InstallerError({
      code: 'HOST_ZFS_POOL_UNHEALTHY',
      facts: [
        ['Observed', `zpool reports name='${hostPoolName || 'unknown'}' and health='${hostPoolHealth || 'unknown'}'.`],
      ],
      retry,
    })
  }
  const hostDataset = await runProcess(host.commandPaths.zfs, ['list', '-H', '-o', 'name', poolName])
  if (hostDataset.exitCode !== 0 || hostDataset.stdout.trim() !== poolName) {
    throw new InstallerError({
      code: 'HOST_ZFS_DATASET_UNAVAILABLE',
      facts: [['Observed', `zfs list did not return the expected '${poolName}' dataset.`]],
      retry,
    })
  }
  const incus = await validateIncusStorage(client, layout, retry)
  return {
    hostPoolHealth,
    ...incus,
  }
}
