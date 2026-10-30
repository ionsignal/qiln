import { isLivePool, poolsEnumerated, readLayout, sameDatasets, scrubTimerRunning, stateMountOf } from './live'
import { arcFileMatches, ZFS_SPEC, type StepAction } from './spec'
import type { ApprovedPlan, CreatePlan, Observation, PoolIdentity } from './types'

type Detail = NonNullable<Observation['pools']['detail']>

/**
 * Zero ashift values are ignored, because a non-leaf vdev reports none. A new
 * pool holds no dataset besides its root.
 */
function configured(plan: CreatePlan, { pool, dataset, ashifts, topLevel }: Detail): boolean {
  const widths = ashifts.filter(width => width > 0)
  return (
    widths.length > 0 &&
    widths.every(width => width === plan.ashift) &&
    pool.autotrim === plan.autotrim &&
    pool.cachefile === ZFS_SPEC.pool.cachefile &&
    dataset.compression === plan.dataset.compression &&
    (dataset.acltype === 'posix' || dataset.acltype === ZFS_SPEC.pool.acltype) &&
    dataset.xattr === ZFS_SPEC.pool.xattr &&
    dataset.atime === plan.dataset.atime &&
    dataset.mountpoint === ZFS_SPEC.pool.mountpoint &&
    topLevel.every(item => item.name === plan.pool)
  )
}

/**
 * Pure check of one step's approved result against a fresh observation. A step
 * is verified only when the host agrees, never because its script exited zero.
 *
 * A created pool takes whatever GUID ZFS assigned, so only the create step
 * checks the pool without one, and its datasets take GUIDs that the dataset
 * step discovers. `recorded` is the identity that the journal recorded for this
 * deployment's pool, which the dataset and scrub steps of a created pool must
 * still find. A mount counts only when ZFS and the kernel mount table agree,
 * and an export only when the pool listing could run, because an unavailable
 * listing looks the same as an empty one.
 */
export function verify(
  action: StepAction,
  plan: ApprovedPlan,
  observation: Observation,
  recorded: PoolIdentity | null,
): boolean {
  const { detail, imported } = observation.pools
  switch (action) {
    case 'install-packages':
      return (
        plan.kind === 'prerequisites' &&
        plan.install.every(change =>
          observation.packages.some(
            found =>
              found.installed &&
              found.name === change.name &&
              found.version === change.version &&
              found.architecture === change.architecture,
          ),
        )
      )
    case 'write-arc':
      return plan.kind === 'prerequisites' && arcFileMatches(observation.arc.ownedLines, plan.arc.maxBytes)
    case 'load-module':
      return observation.module?.loaded === true
    case 'apply-arc':
      return plan.kind === 'prerequisites' && observation.arc.runningMax === plan.arc.maxBytes
    case 'create-pool':
      return (
        plan.kind === 'create' &&
        detail !== null &&
        isLivePool(observation, { name: plan.pool, guid: null, volumeId: plan.disk.volumeId }) &&
        configured(plan, detail)
      )
    case 'create-datasets':
      return (
        plan.kind === 'create' &&
        recorded !== null &&
        isLivePool(observation, { name: plan.pool, guid: recorded.guid, volumeId: plan.disk.volumeId }) &&
        readLayout(observation, plan.pool) !== null
      )
    case 'import-pool':
      return (
        plan.kind === 'import' &&
        isLivePool(observation, { name: plan.pool, guid: plan.guid, volumeId: plan.disk.volumeId }) &&
        sameDatasets(readLayout(observation, plan.pool), plan.datasets)
      )
    case 'mount-state':
      return (
        plan.kind === 'mount' &&
        isLivePool(observation, { name: plan.pool, guid: plan.guid, volumeId: plan.disk.volumeId }) &&
        sameDatasets(readLayout(observation, plan.pool), plan.datasets) &&
        stateMountOf(observation, plan.pool) === 'mounted'
      )
    case 'unmount-state':
      return (
        plan.kind === 'export' &&
        isLivePool(observation, { name: plan.pool, guid: plan.guid, volumeId: plan.disk.volumeId }) &&
        sameDatasets(readLayout(observation, plan.pool), plan.datasets) &&
        stateMountOf(observation, plan.pool) === 'unmounted'
      )
    case 'enable-scrub': {
      if (plan.kind !== 'create' && plan.kind !== 'import') {
        return false
      }
      const guid = plan.kind === 'import' ? plan.guid : (recorded?.guid ?? null)
      return (
        guid !== null &&
        scrubTimerRunning(observation) &&
        isLivePool(observation, { name: plan.pool, guid, volumeId: plan.disk.volumeId })
      )
    }
    case 'export-pool':
      return (
        plan.kind === 'export' &&
        poolsEnumerated(observation) &&
        !imported.some(pool => pool.name === plan.pool || pool.guid === plan.guid)
      )
  }
}
