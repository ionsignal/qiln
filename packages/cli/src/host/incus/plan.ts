import { guardOf } from './activation'
import { compareSoftware, isPinned } from './baseline'
import { allocationReasons } from './idmap'
import { sha256Of } from './recipe'
import {
  ARCHITECTURES,
  INCUS_SPEC,
  REQUIRED_PACKAGES,
  packagePins,
  repositoryPreferences,
  repositorySource,
  sysctlOverride,
} from './spec'
import {
  activeUnits,
  baselineDrift,
  closed,
  daemonReasons,
  excludedInstalled,
  fromRepository,
  kernelReasons,
  listed,
  poolImported,
  quiescent,
  stateMountReasons,
  toolchainReasons,
} from './verify'
import { transactionViolations } from '../apt'
import { datasetNamesOf, ZFS_SPEC } from '../zfs/spec'
import { instanceKey, type InstanceRef } from './types'
import type { Preseed } from './preseed'
import type {
  AccessPlan,
  Api,
  IncusTarget,
  Observation,
  PreparationPlan,
  Progress,
  ReadyPlan,
  RefusedPlan,
  ReleasePlan,
  ReleaseTarget,
  SoftwareStagePlan,
  SoftwareTarget,
  StoppedPlan,
} from './types'

type File = Observation['repository']['key']

/**
 * An absent file will be written. A present one must already hold exactly the
 * approved bytes, and anything else is never overwritten.
 */
function fits(file: File, digest: string): boolean {
  return file.kind === 'absent' || (file.kind === 'file' && file.sha256 === digest)
}

/**
 * A fresh open needs an empty state directory. A preserved open needs the
 * retained metadata, and never falls back to a fresh installation.
 */
function stateReasons({ state }: Observation, preserved: boolean): string[] {
  if (preserved) {
    return state.metadata
      ? []
      : ['The state directory does not hold the retained Incus metadata, and Qiln never opens a preserved installation as a fresh one.']
  }
  return state.empty
    ? []
    : ['The state directory is not empty, so this is not a fresh installation, and Qiln never opens retained Incus state as a fresh one.']
}

/**
 * Reasons that this is not a pristine Incus installation on a pool with no
 * Incus data. Initialization merges into existing state, so anything but a
 * blank daemon is refused, and retained Incus data is only ever reopened by
 * its own plan. The pool must hold exactly its root, its state dataset, and an
 * `incus` dataset without descendants, and only the state dataset may be
 * mounted, at the state directory.
 */
function freshReasons(observation: Observation, api: Api, target: IncusTarget): string[] {
  const reasons: string[] = []
  const expect = (passed: boolean, reason: string) => {
    if (!passed) {
      reasons.push(reason)
    }
  }
  const { name: bridge, subnet } = INCUS_SPEC.network
  const names = datasetNamesOf(target.pool)
  const wanted = [target.pool, names.state, names.incus]
  const { datasets } = observation.zfs
  expect(Object.keys(api.server.config).length === 0, 'The Incus server already has configuration.')
  expect(api.projects.length === 1 && api.projects.every(name => name === 'default'), 'Incus has projects other than default.')
  expect(api.pools.length === 0, 'Incus already has a storage pool.')
  expect(!api.networks.some(network => network.managed), 'Incus already has a managed network.')
  expect(
    !api.networks.some(network => network.name === bridge) && !observation.network.links.includes(bridge),
    `A network interface named ${bridge} already exists.`,
  )
  expect(
    api.profiles.length === 1 &&
      api.profiles.every(
        profile =>
          profile.name === 'default' &&
          Object.keys(profile.config).length === 0 &&
          Object.keys(profile.devices).length === 0,
      ),
    'The Incus profiles are not the pristine default.',
  )
  expect(api.instances.length === 0 && api.images === 0, 'Incus already holds instances or images.')
  expect(
    datasets.length === wanted.length && wanted.every(name => datasets.some(dataset => dataset.name === name)),
    `The pool ${target.pool} must hold exactly its root, ${names.state}, and an empty ${names.incus}. Anything else indicates retained Incus data, which is reopened only by its own plan, and Qiln never adopts or wipes it.`,
  )
  expect(
    datasets.every(dataset => !dataset.mounted || dataset.name === names.state),
    `A dataset of the pool ${target.pool} other than ${names.state} is mounted.`,
  )
  reasons.push(...stateMountReasons(observation, target))
  expect(observation.network.routes.length === 0, `A host route or address overlaps ${subnet}.`)
  return reasons
}

/**
 * The last preparation stage, reached only from a verified baseline. A missing
 * administration group is refused, because the packages create it and Qiln
 * never creates groups. An account that already belongs needs nothing.
 */
function accessPlan(observation: Observation, target: IncusTarget): AccessPlan | ReadyPlan | RefusedPlan {
  const { access } = observation
  const { group } = INCUS_SPEC.access
  if (!access.groupExists) {
    return { kind: 'refused', reasons: [`The group ${group} does not exist on the host, and Qiln does not create groups.`] }
  }
  if (access.member) {
    return { kind: 'ready', pool: target.pool, guid: target.guid }
  }
  return { kind: 'access', account: target.account, group }
}

/**
 * Pure decision over the software stage: close the host, then the repository and
 * exact-package preferences, then the packages, installed while the host is
 * closed. Closing masks the units and installs the sysctl override that keeps
 * the AppArmor restriction enabled. It needs no pool and no state mount, so it
 * runs before either exists, and nothing it plans touches the state directory.
 * Each stage needs its own approval and a fresh inspection before the next.
 * Installed Incus packages must match the selected native pins; differences
 * refuse before further preparation, never offering an upgrade or downgrade. A
 * retained baseline that conflicts with the selected pins is refused rather
 * than replaced. The kernel floor is judged from the first stage on.
 * `progress.opened` says that a verified open or initialization already let the
 * daemon run, so the closed host is no longer expected, and no package is
 * planned, because a package script restarts a running daemon.
 */
export function softwarePlanOf(observation: Observation, target: SoftwareTarget, progress: Progress): SoftwareStagePlan {
  const { system, repository, sysctl, transaction } = observation
  const { keyUrl, keySha256 } = INCUS_SPEC.repository
  const refusals: string[] = []
  const expect = (passed: boolean, reason: string) => {
    if (!passed) {
      refusals.push(reason)
    }
  }
  const refused = (reasons: string[] = refusals): RefusedPlan => ({ kind: 'refused', reasons })
  const architecture = ARCHITECTURES.find(name => name === system.packageArchitecture)
  const sourceDigest = architecture === undefined ? null : sha256Of(repositorySource(architecture))
  const preferencesDigest = architecture === undefined ? null : sha256Of(repositoryPreferences(architecture))
  const sysctlDigest = sha256Of(sysctlOverride())
  expect(architecture !== undefined, 'The host package architecture is neither amd64 nor arm64.')
  refusals.push(...kernelReasons(observation))
  const excluded = excludedInstalled(observation)
  expect(
    excluded.length === 0,
    `Incus packages outside the container-only scope are installed (${excluded.join(', ')}), and Qiln does not remove them.`,
  )
  expect(
    repository.conflicts.length === 0,
    'Another APT source already references the Zabbly repository, and Qiln does not edit other configuration.',
  )
  expect(
    fits(repository.key, keySha256),
    'The Zabbly keyring file exists but does not hold the approved key, and Qiln never overwrites it.',
  )
  expect(
    sourceDigest === null || fits(repository.source, sourceDigest),
    'The Zabbly source file exists but does not hold the approved source, and Qiln never overwrites it.',
  )
  expect(
    preferencesDigest === null || fits(repository.preferences, preferencesDigest),
    'The Qiln Incus preferences file exists but does not hold the selected exact package pins, and Qiln never overwrites it.',
  )
  expect(
    fits(sysctl.override, sysctlDigest),
    'The Qiln Incus sysctl override file exists but does not hold the approved bytes, and Qiln never overwrites it.',
  )
  expect(
    progress.opened || activeUnits(observation).length === 0,
    `Incus units are already active (${activeUnits(observation).join(', ')}) before Qiln closed the host, and Qiln does not adopt or stop a running daemon.`,
  )
  if (refusals.length > 0 || architecture === undefined || sourceDigest === null || preferencesDigest === null) {
    return refused()
  }
  const selected = packagePins(architecture)
  const selectedComparison = compareSoftware({ architecture, packages: selected }, observation)
  if (selectedComparison.kind === 'differs') {
    return refused(selectedComparison.reasons.map(reason => `${reason} Qiln never upgrades, downgrades, or swaps package architectures.`))
  }
  if (target.retained !== null) {
    const { baseline } = target.retained
    if (
      baseline.architecture !== architecture ||
      !selected.every(pin =>
        baseline.packages.some(
          recorded =>
            recorded.name === pin.name &&
            recorded.version === pin.version &&
            recorded.architecture === pin.architecture,
        ),
      )
    ) {
      return refused(['The retained Incus baseline does not match this recipe’s exact native package pins. Qiln never substitutes new builds for retained software or offers an upgrade or downgrade.'])
    }
  }
  const preserved = progress.opened ? null : target.retained
  const comparison = preserved === null ? selectedComparison : compareSoftware(preserved.baseline, observation)
  if (comparison.kind === 'differs') {
    return refused(comparison.reasons)
  }
  if (!progress.opened && (!closed(observation) || sysctl.override.kind === 'absent')) {
    return { kind: 'close', sysctl: { sha256: sysctlDigest } }
  }
  const add =
    repository.key.kind === 'absent' ||
    repository.source.kind === 'absent' ||
    repository.preferences.kind === 'absent'
  if (add || !listed(observation)) {
    return {
      kind: 'repository',
      architecture,
      add,
      key: { url: keyUrl, sha256: keySha256 },
      source: { sha256: sourceDigest },
      preferences: { sha256: preferencesDigest },
    }
  }
  const missing = comparison.kind === 'install' ? comparison.packages.map(change => change.name) : []
  if (missing.length === 0) {
    return { kind: 'software' }
  }
  if (progress.opened) {
    return refused(['Incus packages are missing after the daemon was opened. A package script restarts a running daemon, and Qiln never installs software under it.'])
  }
  const unavailable = selected.filter(
    pin =>
      missing.includes(pin.name) &&
      !repository.candidates.some(
        candidate =>
          candidate.package === pin.name && candidate.version === pin.version && fromRepository(candidate.source),
      ),
  )
  expect(
    unavailable.length === 0,
    `APT does not list the selected packages (${unavailable.map(pin => `${pin.name}=${pin.version}`).join(', ')}) from the approved repository for ${architecture}. No other build is substituted.`,
  )
  refusals.push(
    ...transactionViolations(transaction, {
      missing,
      architecture: system.packageArchitecture,
      maximum: INCUS_SPEC.maximumInstalls,
      label: preserved === null ? 'exact pinned Incus' : 'recorded Incus',
    }),
  )
  if (transaction !== null) {
    expect(
      transaction.installs
        .filter(change => REQUIRED_PACKAGES.includes(change.name))
        .every(
          change =>
            selected.some(
              pin =>
                pin.name === change.name &&
                pin.version === change.version &&
                pin.architecture === change.architecture,
            ) &&
            repository.candidates.some(
              candidate =>
                candidate.package === change.name &&
                candidate.version === change.version &&
                fromRepository(candidate.source),
            ),
        ),
      'APT planned an Incus package that does not match the exact native pin listed by the approved repository.',
    )
    if (preserved !== null) {
      expect(
        transaction.installs.every(
          change =>
            !isPinned(change.name) ||
            preserved.baseline.packages.some(
              recorded =>
                recorded.name === change.name &&
                recorded.version === change.version &&
                recorded.architecture === change.architecture,
            ),
        ),
        'APT planned a pinned Incus package at a version or architecture that was not recorded.',
      )
    }
  }
  return refusals.length > 0 || transaction === null ? refused() : { kind: 'packages', install: transaction.installs }
}

/**
 * Pure decision over one observation: the software stage first, then, once the
 * recorded pool is imported and its state dataset mounted, the storage-identity
 * guard, the open, the initialization, and socket access. Each stage needs its
 * own approval and a fresh inspection before the next. The toolchain floors, the
 * state directory, and the subordinate-ID allocations are judged before the
 * guard, so a host that cannot be opened is refused before anything more is
 * installed. A preserved installation (`target.retained`) also requires its
 * recorded software and root ranges. A preserved open requires retained
 * metadata and never reaches initialization. `progress.retained` is the preseed
 * document of an earlier verified initialization or preserved open, in which
 * case a matching baseline proceeds to access and any drift is refused.
 */
export function planOf(
  observation: Observation,
  target: IncusTarget,
  preseed: Preseed,
  progress: Progress,
): PreparationPlan {
  const software = softwarePlanOf(observation, target, progress)
  if (software.kind !== 'software') {
    return software
  }
  const { api, guard } = observation
  const { expectation, check, dropIn } = guardOf(target)
  const preserved = progress.opened ? null : target.retained
  const refusals: string[] = []
  const expect = (passed: boolean, reason: string) => {
    if (!passed) {
      refusals.push(reason)
    }
  }
  expect(
    poolImported(observation, target.pool, target.guid),
    `The recorded pool ${target.pool} (GUID ${target.guid}) is not imported on the host.`,
  )
  expect(
    fits(guard.expectation, expectation.sha256),
    'The Qiln Incus expectation file exists but does not hold the approved identities, and Qiln never overwrites it.',
  )
  expect(
    fits(guard.check, check.sha256),
    'The Qiln Incus startup check exists but does not hold the approved bytes, and Qiln never overwrites it.',
  )
  expect(
    fits(guard.dropIn, dropIn.sha256),
    'The Qiln Incus service drop-in exists but does not hold the approved bytes, and Qiln never overwrites it.',
  )
  refusals.push(...toolchainReasons(observation))
  if (!progress.opened) {
    refusals.push(
      ...stateMountReasons(observation, target),
      ...stateReasons(observation, preserved !== null),
      ...allocationReasons(observation, preserved?.baseline.allocations ?? null),
    )
  }
  if (refusals.length > 0) {
    return { kind: 'refused', reasons: refusals }
  }
  const guarded = guard.expectation.kind === 'file' && guard.check.kind === 'file' && guard.dropIn.kind === 'file'
  if (!guarded) {
    return {
      kind: 'guard',
      pool: target.pool,
      guid: target.guid,
      datasets: target.datasets,
      layout: ZFS_SPEC.layout.revision,
      expectation: { sha256: expectation.sha256 },
      check: { sha256: check.sha256 },
      dropIn: { sha256: dropIn.sha256 },
    }
  }
  if (!progress.opened) {
    return {
      kind: 'open',
      pool: target.pool,
      guid: target.guid,
      datasets: target.datasets,
      check: { sha256: check.sha256 },
      retained: preserved,
    }
  }
  if (api === null) {
    return { kind: 'refused', reasons: ['The Incus daemon service is not running, so its state cannot be read. Qiln does not start units outside the approved open step, it does not read through a socket that would start the daemon, and it has no step that reopens a released Incus on the same deployment.'] }
  }
  if (progress.retained !== null) {
    const drift = baselineDrift(observation, target, progress.retained)
    return drift.length === 0 ? accessPlan(observation, target) : { kind: 'refused', reasons: drift }
  }
  const conflicts = [...daemonReasons(observation, api), ...freshReasons(observation, api, target)]
  if (conflicts.length > 0) {
    return { kind: 'refused', reasons: conflicts }
  }
  return {
    kind: 'initialize',
    pool: target.pool,
    guid: target.guid,
    datasets: target.datasets,
    preseed: { yaml: preseed.yaml, sha256: preseed.sha256 },
  }
}

function byKey(left: InstanceRef, right: InstanceRef): number {
  const first = instanceKey(left)
  const second = instanceKey(right)
  return first < second ? -1 : first > second ? 1 : 0
}

/**
 * Decides what Incus needs before the ZFS export that precedes AWS removal.
 * Units that are all positively inactive need nothing only when a verified
 * release is already recorded after the last opening. Inactive units without
 * that evidence are refused, because Qiln never starts Incus to produce it.
 * Otherwise the instance inventory is frozen, so the workload step can refuse
 * any difference, and the daemon is released after it. Ephemeral instances are
 * refused, because stopping them deletes them. The pool must stay imported,
 * because the separate ZFS export owns exporting.
 */
export function releasePlanOf(
  observation: Observation,
  target: ReleaseTarget,
  released: boolean,
): RefusedPlan | ReleasePlan | StoppedPlan {
  if (quiescent(observation)) {
    return released
      ? { kind: 'stopped' }
      : {
          kind: 'refused',
          reasons: [
            'Every Incus unit is inactive, but no verified release is recorded after the last opening. Qiln never starts Incus to produce release evidence.',
          ],
        }
  }
  const reasons: string[] = []
  if (!poolImported(observation, target.pool, target.guid)) {
    reasons.push(`The recorded pool ${target.pool} (GUID ${target.guid}) is not imported on the host.`)
  }
  const { api } = observation
  if (api === null) {
    reasons.push(
      'An Incus unit is active but the daemon service is not running, so its instances cannot be enumerated. Qiln does not start units or read through a socket that would start the daemon.',
    )
    return { kind: 'refused', reasons }
  }
  const { maximumRunning, maximumInstances, stopTimeoutSeconds } = INCUS_SPEC.release
  const ephemeral = api.instances.filter(instance => instance.ephemeral)
  const active = api.instances.filter(instance => instance.status !== 'Stopped')
  if (ephemeral.length > 0) {
    reasons.push(
      `Ephemeral instances (${ephemeral.map(instanceKey).join(', ')}) are deleted when they stop, and Qiln does not stop them.`,
    )
  }
  if (active.length > maximumRunning) {
    reasons.push(
      `${active.length} instances are not stopped, which is more than the ${maximumRunning} that one bounded release can stop gracefully within ${stopTimeoutSeconds} seconds each.`,
    )
  }
  if (api.instances.length > maximumInstances) {
    reasons.push(`Incus holds more than ${maximumInstances} instances, which is more than a release can freeze.`)
  }
  if (reasons.length > 0) {
    return { kind: 'refused', reasons }
  }
  return {
    kind: 'release',
    pool: target.pool,
    guid: target.guid,
    instances: api.instances.map(({ project, name }) => ({ project, name })).sort(byKey),
  }
}
