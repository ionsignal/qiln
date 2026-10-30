import { arcFileMatches, datasetNamesOf, scrubTimerOf, ZFS_SPEC } from './spec'
import { diskOf, layers, memberOf } from './disk'
import { isLivePool, poolsEnumerated, readLayout, sameDatasets, scrubTimerRunning, stateMountOf } from './live'
import { transactionViolations } from '../apt'
import { STATE_MOUNTPOINT } from '../mount'
import type {
  AbsentPlan,
  BlockDevice,
  ExportPlan,
  Observation,
  PackageChange,
  Policy,
  PoolDatasets,
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
 * GUID, and holds exactly its recorded datasets, is accepted. Mounting the
 * state dataset is a plan of its own, decided only once the pool is imported
 * and its scrub timer is verified.
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
  expect(
    pools.detail !== null || observation.stateMount === null,
    `Something is already mounted at ${STATE_MOUNTPOINT} while the pool is not imported, and Qiln does not adopt unexplained mounts.`,
  )
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
    refusals.push(
      ...transactionViolations(transaction, {
        missing,
        architecture: system.packageArchitecture,
        maximum: ZFS_SPEC.maximumInstalls,
        label: 'prerequisite',
      }),
    )
    install = transaction?.installs ?? []
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
  const { datasets } = recorded
  if (datasets === null) {
    return {
      kind: 'refused',
      reasons: [
        'The recorded pool has no verified dataset layout, and Qiln does not create or repair datasets on an existing pool.',
      ],
    }
  }
  const names = datasetNamesOf(recorded.name)
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
    if (!sameDatasets(readLayout(observation, recorded.name), datasets)) {
      return {
        kind: 'refused',
        reasons: [
          `The imported pool ${recorded.name} (GUID ${recorded.guid}) does not hold exactly the recorded ${names.state} and ${names.incus} datasets, and Qiln does not repair or adopt it.`,
        ],
      }
    }
    const state = stateMountOf(observation, recorded.name)
    if (state === 'unexpected') {
      return {
        kind: 'refused',
        reasons: [
          `The mount state of ${names.state} does not agree with the kernel mount table at ${STATE_MOUNTPOINT}, and Qiln does not adopt unexplained mounts.`,
        ],
      }
    }
    if (recorded.staged && scrubTimerRunning(observation)) {
      if (state === 'mounted' && recorded.ready) {
        return { kind: 'ready', pool: recorded.name, guid: recorded.guid }
      }
      return {
        kind: 'mount',
        pool: recorded.name,
        guid: recorded.guid,
        datasets,
        disk: targetDisk(data, target),
        mounted: state === 'mounted',
      }
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
    datasets,
    disk: { ...targetDisk(data, target), member: member.path },
    scrubTimer: scrubTimerOf(recorded.name),
  }
}

type ReleaseLayout = { datasets: PoolDatasets } | { reasons: string[] }

/**
 * An imported pool may be released only when it holds exactly its recorded
 * datasets and nothing but the state dataset is mounted, in agreement with the
 * kernel mount table.
 */
function releaseLayout(observation: Observation, recorded: RecordedPool): ReleaseLayout {
  const { datasets } = recorded
  if (datasets === null) {
    return { reasons: ['The recorded pool has no verified dataset layout, so Qiln cannot tell what to unmount.'] }
  }
  const reasons: string[] = []
  const names = datasetNamesOf(recorded.name)
  if (!sameDatasets(readLayout(observation, recorded.name), datasets)) {
    reasons.push(
      `The imported pool ${recorded.name} (GUID ${recorded.guid}) does not hold exactly the recorded ${names.state} and ${names.incus} datasets, and Qiln does not adopt it.`,
    )
  }
  const others = (observation.pools.detail?.mounted ?? []).filter(name => name !== names.state)
  if (others.length > 0) {
    reasons.push(
      `Datasets of the recorded pool ${recorded.name} are mounted (${others.join(', ')}), and Qiln does not unmount them or force an export.`,
    )
  }
  if (stateMountOf(observation, recorded.name) === 'unexpected') {
    reasons.push(
      `The mount state of ${names.state} does not agree with the kernel mount table at ${STATE_MOUNTPOINT}, and Qiln does not adopt unexplained mounts.`,
    )
  }
  return reasons.length === 0 ? { datasets } : { reasons }
}

/**
 * Decides what the recorded pool needs before the first AWS removal step. A pool
 * observed imported with its recorded name and GUID gets an export plan, which
 * unmounts the state dataset first when it is mounted. Any other mounted
 * dataset refuses it here rather than at the script. A pool observed absent is
 * accepted only when the pool listing could run and retained evidence already
 * records its verified clean export (`exported`), because Qiln never records
 * an export that did nothing and a missing pool without that evidence is
 * unexplained. A pool that matches only the name or only the GUID is never
 * adopted.
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
  if (!poolsEnumerated(observation)) {
    reasons.push('The imported pools could not be listed, because the ZFS tools or module are not available, so absence of the recorded pool is not established.')
  }
  if (imported.some(pool => (pool.name === recorded.name) !== (pool.guid === recorded.guid))) {
    reasons.push(
      `An imported pool shares the name or the GUID of the recorded pool ${recorded.name} (GUID ${recorded.guid}) but not both, and Qiln does not adopt it.`,
    )
  }
  if (poolsEnumerated(observation) && !holdsRecorded && !exported) {
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
  const layout = releaseLayout(observation, recorded)
  if ('reasons' in layout) {
    return { kind: 'refused', reasons: layout.reasons }
  }
  return {
    kind: 'export',
    pool: recorded.name,
    guid: recorded.guid,
    datasets: layout.datasets,
    unmount: stateMountOf(observation, recorded.name) === 'mounted',
    disk: targetDisk(data, target),
    scrubTimer: scrubTimerOf(recorded.name),
  }
}
