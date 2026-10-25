import { diskOf, layers } from './disk'
import type { Observation } from './types'

/**
 * `guid` is null only while a pool is being created, because ZFS assigns the
 * GUID. Every later check passes the recorded one.
 */
export interface ExpectedPool {
  name: string
  guid: string | null
  volumeId: string
}

/**
 * The one definition of a pool in the supported state: imported under the
 * expected identity, ONLINE, and made of exactly one plain disk vdev that is
 * the recorded data disk or a partition on it, with no auxiliary vdevs. Create,
 * import, scrub verification, and `ready` all share it. Missing or malformed
 * detail never passes.
 */
export function isLivePool(observation: Observation, expected: ExpectedPool): boolean {
  const { detail, imported } = observation.pools
  const disk = diskOf(observation.disks, expected.volumeId)
  const found = imported.find(pool => pool.name === expected.name)
  if (disk === null || detail === null || found === undefined) {
    return false
  }
  const [vdev, ...others] = detail.data
  return (
    (expected.guid === null || found.guid === expected.guid) &&
    detail.pool.health === 'ONLINE' &&
    detail.auxiliary.length === 0 &&
    vdev !== undefined &&
    others.length === 0 &&
    vdev.type === 'disk' &&
    vdev.children === 0 &&
    layers(disk).some(layer => layer.path === vdev.path)
  )
}

/**
 * The packaged scrub timer counts only when it is both enabled and running. An
 * enabled timer that is inactive will not scrub until the next boot.
 */
export function scrubTimerRunning(observation: Observation): boolean {
  return observation.timer.enablement === 'enabled' && observation.timer.activation === 'active'
}

/**
 * Absence of a pool is evidence only when the pool listing could actually run,
 * which needs the tools and the loaded module.
 */
export function poolsEnumerated(observation: Observation): boolean {
  return observation.pools.tools && observation.pools.moduleLoaded
}
