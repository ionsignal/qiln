import { arcFileMatches, scrubTimerOf, ZFS_SPEC } from './spec'
import { diskOf, layers, memberOf } from './disk'
import { isLivePool } from './live'
import type {
  AbsentPlan,
  BlockDevice,
  ExportPlan,
  Observation,
  PackageChange,
  Policy,
  PreparationPlan,
  RecordedPool,
  RefusedPlan,
  Signature,
  ZfsTarget,
} from './types'

function mountpoints(device: BlockDevice): string[] {
  return layers(device).flatMap(layer => layer.mountpoints)
}

/**
 * Probe exit 2 only means no signature was found, so blankness also needs a
 * clean topology and no mounts or swap.
 */
function occupiedReasons(disk: BlockDevice, probe: Signature | undefined): string[] {
  const reasons: string[] = []
  if (disk.children.length > 0) {
    reasons.push('has partitions or devices layered on it')
  }
  if (mountpoints(disk).length > 0) {
    reasons.push('is mounted or used as swap')
  }
  if (disk.filesystem !== null) {
    reasons.push('carries a filesystem signature')
  }
  if (probe === undefined || probe.exitCode !== 2 || Object.keys(probe.fields).length > 0) {
    reasons.push('was not confirmed blank by a signature probe')
  }
  return reasons
}

/**
 * A disk that holds a recorded pool is not blank, because ZFS partitions it
 * itself. It only has to be unmounted and carry no signature other than ZFS's
 * own. The pool's identity is verified by GUID during import, not here.
 */
function recordedPoolReasons(disk: BlockDevice): string[] {
  const reasons: string[] = []
  if (mountpoints(disk).length > 0) {
    reasons.push('is mounted or used as swap')
  }
  if (!layers(disk).every(layer => layer.filesystem === null || layer.filesystem === 'zfs_member')) {
    reasons.push('carries a signature that is not a ZFS member')
  }
  return reasons
}

function sectorsOf(disk: BlockDevice, ashift: number): { logical: number; physical: number } | null {
  const { logicalSector, physicalSector } = disk
  const alignment = 2 ** ashift
  return logicalSector !== null &&
    physicalSector !== null &&
    logicalSector <= alignment &&
    physicalSector <= alignment
    ? { logical: logicalSector, physical: physicalSector }
    : null
}

function targetDisk(disk: BlockDevice, target: ZfsTarget) {
  return { path: disk.path, volumeId: target.dataVolumeId, sizeBytes: disk.sizeBytes }
}

/**
 * Pure decision over one observation. It never connects, persists, or
 * mutates. Refusals are collected rather than short-circuited, so one run
 * reports everything that blocks. A pool is never adopted by name alone: with
 * no recorded pool the volume must be blank and no pool of the policy name may
 * be imported, and with a recorded pool only one that matches both its name and
 * GUID is accepted.
 */
export function planOf(
  observation: Observation,
  target: ZfsTarget,
  policy: Policy,
  recorded: RecordedPool | null,
): PreparationPlan {
  const { system, module: zfsModule, arc, pools } = observation
  const refusals: string[] = []
  const expect = (passed: boolean, reason: string) => {
    if (!passed) {
      refusals.push(reason)
    }
  }
  expect(zfsModule !== null, 'No ZFS kernel module was found for the running kernel. Qiln does not install or build one.')
  if (zfsModule !== null) {
    expect(zfsModule.package !== null, 'The ZFS kernel module is not owned by an installed package.')
    expect(
      zfsModule.vermagic.split(' ')[0] === system.kernel,
      'The ZFS kernel module was not built for the running kernel.',
    )
  }
  const root = diskOf(observation.disks, target.rootVolumeId)
  const data = diskOf(observation.disks, target.dataVolumeId)
  expect(
    root !== null && mountpoints(root).includes('/'),
    'The recorded root volume was not found as the one disk that holds /.',
  )
  expect(data !== null, 'The recorded data volume was not found exactly once among the host disks.')
  const sectors = data === null || recorded !== null ? null : sectorsOf(data, policy.ashift)
  if (data !== null) {
    expect(
      data.sizeBytes === target.dataBytes,
      `The data volume reports ${data.sizeBytes} bytes, but the deployment plan recorded ${target.dataBytes} bytes.`,
    )
    if (recorded === null) {
      const probe = observation.signatures.find(candidate => candidate.path === data.path)
      const occupied = occupiedReasons(data, probe)
      expect(
        occupied.length === 0,
        `The recorded data volume is not a confirmed blank target (${occupied.join('; ')}). Qiln never wipes, adopts, or repairs existing storage.`,
      )
      expect(
        sectors !== null,
        `The data volume sector sizes are missing or exceed the pool alignment (ashift ${policy.ashift}).`,
      )
    } else {
      const unfit = recordedPoolReasons(data)
      expect(
        unfit.length === 0,
        `The recorded data volume cannot hold the recorded pool (${unfit.join('; ')}). Qiln never wipes, adopts, or repairs existing storage.`,
      )
    }
  }
  if (recorded === null) {
    expect(
      !pools.imported.some(pool => pool.name === policy.poolName),
      `A pool named ${policy.poolName} is already imported, and Qiln does not adopt existing pools.`,
    )
  } else {
    expect(
      !pools.imported.some(pool => (pool.name === recorded.name) !== (pool.guid === recorded.guid)),
      `An imported pool shares the name or the GUID of the recorded pool ${recorded.name} (GUID ${recorded.guid}) but not both, and Qiln does not adopt it.`,
    )
  }
  const installed = new Set(observation.packages.filter(item => item.installed).map(item => item.name))
  const missing = ZFS_SPEC.packages.filter(name => !installed.has(name))
  let install: PackageChange[] = []
  if (missing.length > 0) {
    const { transaction } = observation
    if (transaction === null) {
      refusals.push('APT could not resolve the prerequisite packages from its current package lists.')
    } else {
      expect(
        transaction.upgrades.length === 0 && transaction.removals.length === 0,
        'Installing the prerequisite packages would upgrade or remove other packages.',
      )
      expect(
        transaction.installs.length <= ZFS_SPEC.maximumInstalls,
        `APT planned more than ${ZFS_SPEC.maximumInstalls} new packages.`,
      )
      expect(
        transaction.configures.every(name => transaction.installs.some(change => change.name === name)),
        'APT planned to configure a package that is not among the new installations, which indicates a half-configured package state.',
      )
      expect(
        missing.every(name => transaction.installs.some(change => change.name === name)),
        'APT did not plan to install every prerequisite package.',
      )
      expect(
        transaction.installs.every(
          change => change.architecture === system.packageArchitecture || change.architecture === 'all',
        ),
        'APT planned a package for a different architecture.',
      )
      install = transaction.installs
    }
  } else {
    expect(pools.tools, 'The prerequisite packages are installed, but zpool was not found.')
  }
  const maxBytes = Math.floor((system.memoryBytes * policy.arcMaxPercent) / 100)
  const defaultMinimum = Math.max(
    Math.floor(system.memoryBytes / ZFS_SPEC.arc.minimumDivisor),
    ZFS_SPEC.arc.floorMinimumBytes,
  )
  const minimum = arc.runningMin !== null && arc.runningMin > 0 ? arc.runningMin : defaultMinimum
  expect(
    Number.isSafeInteger(maxBytes) && maxBytes >= ZFS_SPEC.arc.minimumMaxBytes && maxBytes >= minimum,
    `An ARC limit of ${maxBytes} bytes is below the module limits (${Math.max(ZFS_SPEC.arc.minimumMaxBytes, minimum)} bytes).`,
  )
  expect(
    arc.conflicts.length === 0,
    'ZFS ARC settings exist outside the Qiln-owned file, and Qiln does not edit other configuration.',
  )
  if (refusals.length > 0 || zfsModule === null || data === null) {
    return { kind: 'refused', reasons: refusals }
  }
  if (system.rebootRequired) {
    return { kind: 'reboot' }
  }
  const prerequisites = {
    install,
    loadModule: !zfsModule.loaded,
    arc: {
      maxBytes,
      percent: policy.arcMaxPercent,
      memoryBytes: system.memoryBytes,
      writeFile: !arcFileMatches(arc.ownedLines, maxBytes),
      applyRuntime: zfsModule.loaded && arc.runningMax !== maxBytes,
    },
    expectedPool: recorded?.guid ?? null,
  }
  if (
    prerequisites.install.length > 0 ||
    prerequisites.loadModule ||
    prerequisites.arc.writeFile ||
    prerequisites.arc.applyRuntime
  ) {
    return { kind: 'prerequisites', ...prerequisites }
  }
  if (!observation.units.some(unit => unit.name === ZFS_SPEC.scrubTemplate)) {
    return { kind: 'refused', reasons: ['The packaged monthly scrub timer was not found. Qiln does not create its own.'] }
  }
  if (recorded === null) {
    if (sectors === null) {
      return { kind: 'refused', reasons: refusals }
    }
    return {
      kind: 'create',
      pool: policy.poolName,
      disk: {
        path: data.path,
        volumeId: target.dataVolumeId,
        sizeBytes: data.sizeBytes,
        logicalSector: sectors.logical,
        physicalSector: sectors.physical,
      },
      ashift: policy.ashift,
      autotrim: policy.autotrim,
      dataset: {
        compression: policy.compression,
        atime: policy.atime,
      },
      scrubTimer: scrubTimerOf(policy.poolName),
    }
  }
  const imported = pools.imported.some(pool => pool.name === recorded.name && pool.guid === recorded.guid)
  if (imported) {
    const live = isLivePool(observation, { name: recorded.name, guid: recorded.guid, volumeId: target.dataVolumeId })
    if (!live) {
      return {
        kind: 'refused',
        reasons: [
          `The imported pool ${recorded.name} (GUID ${recorded.guid}) is not ONLINE as a single plain disk on the recorded data volume, and Qiln does not repair or adopt it.`,
        ],
      }
    }
    if (recorded.ready && observation.timer === 'enabled') {
      return { kind: 'ready', pool: recorded.name, guid: recorded.guid }
    }
  }
  const member = memberOf(data)
  if (member === null) {
    return {
      kind: 'refused',
      reasons: ['The recorded data volume does not have exactly one ZFS member partition to import the recorded pool from.'],
    }
  }
  return {
    imported,
    kind: 'import',
    pool: recorded.name,
    guid: recorded.guid,
    disk: { ...targetDisk(data, target), member: member.path },
    scrubTimer: scrubTimerOf(recorded.name),
  }
}

/**
 * Decides what the recorded pool needs before the first AWS removal step. A pool
 * observed imported with its recorded name and GUID gets an export plan. A pool
 * observed absent is accepted only when retained evidence already records its
 * verified clean export (`exported`), because Qiln never records an export that
 * did nothing and a missing pool without that evidence is unexplained. A
 * pool that matches only the name or only the GUID is never adopted.
 */
export function releasePlanOf(
  observation: Observation,
  target: ZfsTarget,
  recorded: RecordedPool,
  exported: boolean,
): RefusedPlan | ExportPlan | AbsentPlan {
  const data = diskOf(observation.disks, target.dataVolumeId)
  const { imported } = observation.pools
  const holdsRecorded = imported.some(pool => pool.name === recorded.name && pool.guid === recorded.guid)
  const reasons: string[] = []
  if (data === null) {
    reasons.push('The recorded data volume was not found exactly once among the host disks.')
  }
  if (imported.some(pool => (pool.name === recorded.name) !== (pool.guid === recorded.guid))) {
    reasons.push(
      `An imported pool shares the name or the GUID of the recorded pool ${recorded.name} (GUID ${recorded.guid}) but not both, and Qiln does not adopt it.`,
    )
  }
  if (!holdsRecorded && !exported) {
    reasons.push(
      `The recorded pool ${recorded.name} (GUID ${recorded.guid}) is not imported on the host. Run prepare, which re-imports it, then export it.`,
    )
  }
  if (data === null || reasons.length > 0) {
    return { kind: 'refused', reasons }
  }
  if (!holdsRecorded) {
    return { kind: 'absent', pool: recorded.name, guid: recorded.guid }
  }
  return {
    kind: 'export',
    pool: recorded.name,
    guid: recorded.guid,
    disk: targetDisk(data, target),
    scrubTimer: scrubTimerOf(recorded.name),
  }
}
