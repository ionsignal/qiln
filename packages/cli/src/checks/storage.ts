import { QilnInstallerError } from '../error'
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
    throw new QilnInstallerError({
      code: 'HOST_ZFS_POOL_MISSING',
      check: 'existing host ZFS pool',
      summary: `The required host ZFS pool '${INSTALLER_SPEC.storage.poolName}' is unavailable.`,
      observed: `zpool list could not find or inspect '${INSTALLER_SPEC.storage.poolName}'.`,
      reason: 'Qiln does not create, import, format, repair, or reconfigure host ZFS pools.',
      operatorAction: `Have the operator create or import and review the host ZFS pool '${INSTALLER_SPEC.storage.poolName}' manually, then confirm it is healthy with 'sudo zpool status ${INSTALLER_SPEC.storage.poolName}'.`,
      rerun: 'qiln doctor',
    })
  }
  const [hostPoolName, hostPoolHealth] = hostPool.stdout.trim().split(/\s+/)
  if (hostPoolName !== INSTALLER_SPEC.storage.poolName || hostPoolHealth !== 'ONLINE') {
    throw new QilnInstallerError({
      code: 'HOST_ZFS_POOL_UNHEALTHY',
      check: 'host ZFS pool health',
      summary: `The required host ZFS pool '${INSTALLER_SPEC.storage.poolName}' is not healthy.`,
      observed: `zpool reports name='${hostPoolName || 'unknown'}' and health='${hostPoolHealth || 'unknown'}'.`,
      reason: 'Qiln must not place persistent PostgreSQL data onto a degraded or incompatible host pool.',
      operatorAction: `Review 'sudo zpool status ${INSTALLER_SPEC.storage.poolName}' and repair the pool manually. Qiln will not attempt a repair.`,
      rerun: 'qiln doctor',
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
    throw new QilnInstallerError({
      code: 'HOST_ZFS_DATASET_UNAVAILABLE',
      check: 'host ZFS root dataset',
      summary: `The root dataset for '${INSTALLER_SPEC.storage.poolName}' is unavailable.`,
      observed: `zfs list did not return the expected '${INSTALLER_SPEC.storage.poolName}' dataset.`,
      reason: 'The existing Incus ZFS pool must be backed by the documented host zpool.',
      operatorAction:
        'Inspect the host ZFS pool and dataset hierarchy manually without asking Qiln to import or reconfigure it.',
      rerun: 'qiln doctor',
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
    throw new QilnInstallerError({
      code: 'INCUS_STORAGE_POOL_MISSING',
      check: 'existing Incus storage pool',
      summary: `The required Incus storage pool '${INSTALLER_SPEC.storage.poolName}' does not exist.`,
      observed: `GET /1.0/storage-pools/${INSTALLER_SPEC.storage.poolName} returned not found.`,
      reason: 'The MVP requires an existing reviewed Incus ZFS storage pool and does not modify host ZFS resources.',
      operatorAction: `After reviewing the host pool, an authorized operator may manually run 'incus storage create ${INSTALLER_SPEC.storage.poolName} zfs source=${INSTALLER_SPEC.storage.poolName}'.`,
      rerun: 'qiln doctor',
    })
  }
  const incusPoolCompatible =
    incusPool.name === INSTALLER_SPEC.storage.poolName &&
    incusPool.driver === INSTALLER_SPEC.storage.driver &&
    incusPool.status === 'Created' &&
    incusPool.config.source === INSTALLER_SPEC.storage.poolName
  if (!incusPoolCompatible) {
    throw new QilnInstallerError({
      code: 'INCOMPATIBLE_INCUS_STORAGE_POOL',
      check: 'Incus storage-pool compatibility',
      summary: `The existing Incus storage pool '${INSTALLER_SPEC.storage.poolName}' is incompatible.`,
      observed: `Incus reports driver='${incusPool.driver}', status='${incusPool.status || 'unknown'}', and source='${incusPool.config.source ?? 'unset'}'.`,
      reason:
        'Qiln will not replace, import, repair, or reconfigure an existing storage pool with conflicting provider state.',
      operatorAction:
        'Inspect the existing Incus storage pool and host zpool manually. Resolve the conflict without deleting persistent data.',
      rerun: 'qiln doctor',
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
