import { isLivePool, poolsEnumerated, scrubTimerRunning } from './live'
import { arcFileMatches, ZFS_SPEC, type StepAction } from './spec'
import type { ApprovedPlan, CreatePlan, Observation } from './types'

type Detail = NonNullable<Observation['pools']['detail']>

/**
 * Zero ashift values are ignored, because a non-leaf vdev reports none.
 */
function configured(plan: CreatePlan, { pool, dataset, ashifts }: Detail): boolean {
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
    dataset.mountpoint === ZFS_SPEC.pool.mountpoint
  )
}

/**
 * Pure check of one step's approved result against a fresh observation. A step
 * is verified only when the host agrees, never because its script exited zero.
 * 
 * A created pool takes whatever GUID ZFS assigned, so only the create step
 * checks the pool without one. `recordedGuid` is the GUID that the journal
 * recorded for this deployment's pool, which the scrub step of a created pool
 * must still find. An export counts only when the pool listing could run,
 * because an unavailable listing looks the same as an empty one.
 */
export function verify(
  action: StepAction,
  plan: ApprovedPlan,
  observation: Observation,
  recordedGuid: string | null,
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
    case 'import-pool':
      return (
        plan.kind === 'import' &&
        isLivePool(observation, { name: plan.pool, guid: plan.guid, volumeId: plan.disk.volumeId })
      )
    case 'enable-scrub': {
      if (plan.kind !== 'create' && plan.kind !== 'import') {
        return false
      }
      const guid = plan.kind === 'import' ? plan.guid : recordedGuid
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
