import { guardOf } from './activation'
import { manifestOf } from './artifacts'
import { compareSoftware } from './baseline'
import { allocationReasons } from './idmap'
import { sha256Of } from './recipe'
import { selectPins, versionOf } from './select'
import {
  ARCHITECTURES,
  INCUS_SPEC,
  REQUIRED_PACKAGES,
  repositoryPreferences,
  repositorySource,
  sysctlOverride,
} from './spec'
import {
  artifactsReasons,
  baselineDrift,
  closed,
  daemonReasons,
  excludedInstalled,
  fromRepository,
  installedPins,
  kernelReasons,
  listed,
  poolImported,
  quiescent,
  stateMountReasons,
  toolchainReasons,
} from './verify'
import { transactionViolations } from '../apt'
import { datasetNamesOf } from '../zfs/spec'
import { instanceKey, type InstanceRef } from './types'
import type { Preseed } from './preseed'
import type {
  AccessPlan,
  Api,
  CapturePlan,
  IncusTarget,
  Observation,
  PreparationPlan,
  Progress,
  ReadyPlan,
  RefusedPlan,
  ReleasePlan,
  ReleaseTarget,
  RepositoryPlan,
  RestorePlan,
  Retained,
  SoftwareStagePlan,
  SoftwareTarget,
  StoppedPlan,
} from './types'

type File = Observation['repository']['key']

/**
 * An absent file will be written. A present one must hold exactly the approved
 * bytes, and nothing is overwritten.
 */
function fits(file: File, digest: string): boolean {
  return file.kind === 'absent' || (file.kind === 'file' && file.sha256 === digest)
}

/**
 * A fresh open needs an empty state directory. A preserved open needs the
 * retained metadata and never falls back to a fresh installation.
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
 * Reasons that this is not a pristine Incus installation on a pool with no Incus
 * data. Initialization merges into existing state, so anything but a blank
 * daemon is refused, and retained data is only reopened by its own plan. The
 * pool must hold exactly its root, its state dataset, an `incus` dataset
 * without descendants, and the artifacts dataset, and only the state dataset
 * may be mounted, at the state directory.
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
  const wanted = [target.pool, names.state, names.incus, names.artifacts]
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
    `The pool ${target.pool} must hold exactly its root, ${names.state}, an empty ${names.incus}, and ${names.artifacts}. Anything else indicates retained Incus data, which is reopened only by its own plan, and Qiln never adopts or wipes it.`,
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
 * administration group is refused, because the packages create it and Qiln never
 * creates groups. An account that already belongs needs nothing.
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
 * Pure decision over the software stage, in order:
 * 1. Closing preconditions: the sysctl override must fit, and until a verified
 *    open or initialization exists every unit must be positively inactive.
 * 2. Every other refusal that offline evidence decides (kernel floor, excluded
 *    packages, APT configuration, recorded baseline), so a host that cannot be
 *    prepared is refused before the first mask.
 * 3. Closing (masks plus the override that keeps the AppArmor restriction
 *    enabled), carrying the repository plan when a fresh host lacks the files
 *    or refreshed lists. Otherwise the repository plan alone.
 * 4. A recorded installation, preserved or already opened, stops here: it is
 *    never installed from a repository, and its retained package files are
 *    restored by the activation stage instead.
 * 5. Selection: once the lists are refreshed, a fresh host chooses the newest
 *    supported Incus build that they list. Installed Incus packages must share
 *    one supported build.
 * 6. Packages, installed while the host is closed, with the preferences file
 *    that pins the build. Refusals that need refreshed package lists can only
 *    follow the repository stage.
 * Installed Incus packages are never upgraded or downgraded, and a conflicting
 * recorded baseline is refused rather than replaced. Once `progress.opened`,
 * closing and package installation are never planned again, because a package
 * script restarts a running daemon.
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
  const sysctlDigest = sha256Of(sysctlOverride())
  expect(
    fits(sysctl.override, sysctlDigest),
    'The Qiln Incus sysctl override file exists but does not hold the approved bytes, and Qiln never overwrites it.',
  )
  expect(
    progress.opened || quiescent(observation),
    'Incus units are not positively inactive before Qiln closed the host, and Qiln does not adopt or stop a running daemon.',
  )
  if (refusals.length > 0) {
    return refused()
  }
  const architecture = ARCHITECTURES.find(name => name === system.packageArchitecture)
  const sourceDigest = architecture === undefined ? null : sha256Of(repositorySource(architecture))
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
  if (refusals.length > 0 || architecture === undefined || sourceDigest === null) {
    return refused()
  }
  const recorded = (progress.opened ? progress.baseline : target.retained?.baseline) ?? null
  const comparison = recorded === null ? null : compareSoftware(recorded, observation)
  if (comparison !== null && comparison.kind === 'differs') {
    return refused(comparison.reasons)
  }
  const add = repository.key.kind === 'absent' || repository.source.kind === 'absent'
  const repositoryPlan: RepositoryPlan | null =
    recorded === null && (add || !listed(observation))
      ? {
          kind: 'repository',
          architecture,
          add,
          key: { url: keyUrl, sha256: keySha256 },
          source: { sha256: sourceDigest },
        }
      : null
  if (!progress.opened && (!closed(observation) || sysctl.override.kind === 'absent')) {
    return { kind: 'close', sysctl: { sha256: sysctlDigest }, repository: repositoryPlan }
  }
  if (repositoryPlan !== null) {
    return repositoryPlan
  }
  if (comparison !== null) {
    return comparison.kind === 'missing' && progress.opened
      ? refused(['Incus packages are missing after the daemon was opened. A package script restarts a running daemon, and Qiln never installs software under it.'])
      : { kind: 'software' }
  }
  const selection = selectPins(observation, architecture)
  if ('reasons' in selection) {
    return refused(selection.reasons)
  }
  const { pins } = selection
  const installed = installedPins(observation)
  const missing = REQUIRED_PACKAGES.filter(name => !installed.some(pin => pin.name === name))
  if (missing.length === 0) {
    return { kind: 'software' }
  }
  if (progress.opened) {
    return refused(['Incus packages are missing after the daemon was opened. A package script restarts a running daemon, and Qiln never installs software under it.'])
  }
  const version = versionOf(pins)
  if (version === null) {
    return refused(['The Incus packages to install do not share one version.'])
  }
  const preferencesDigest = sha256Of(repositoryPreferences(version))
  expect(
    fits(repository.preferences, preferencesDigest),
    'The Qiln Incus preferences file exists but does not hold the selected exact package pins, and Qiln never overwrites it.',
  )
  if (refusals.length > 0) {
    return refused()
  }
  if (progress.pins === null) {
    return { kind: 'select', pins }
  }
  const unavailable = pins.filter(
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
      label: 'selected Incus',
    }),
  )
  if (transaction !== null) {
    expect(
      transaction.installs
        .filter(change => REQUIRED_PACKAGES.includes(change.name))
        .every(
          change =>
            pins.some(
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
      'APT planned an Incus package that does not match the selected pin listed by the approved repository.',
    )
  }
  return refusals.length > 0 || transaction === null
    ? refused()
    : { kind: 'packages', install: transaction.installs, preferences: { version, sha256: preferencesDigest } }
}

/**
 * The capture of the installed package files, frozen as a manifest. It needs
 * the recorded transaction, every file of it staged with the size and SHA-256
 * that the repository index lists, and the artifacts dataset unmounted with its
 * recorded identity.
 */
function capturePlanOf(observation: Observation, target: IncusTarget, progress: Progress): CapturePlan | RefusedPlan {
  if (progress.closure === null) {
    return {
      kind: 'refused',
      reasons: ['No verified Incus package installation is recorded, so there are no package files to capture.'],
    }
  }
  const captured = manifestOf(progress.closure, observation.stage, observation.index)
  const reasons = [...artifactsReasons(observation, target), ...('reasons' in captured ? captured.reasons : [])]
  if ('reasons' in captured || reasons.length > 0) {
    return { kind: 'refused', reasons }
  }
  return { kind: 'capture', pool: target.pool, guid: target.guid, datasets: target.datasets, manifest: captured.manifest }
}

/**
 * The restore of a preserved installation's retained package files, frozen as
 * the manifest that the earlier capture recorded. It never reads a repository,
 * so it can never substitute another build. It needs the recorded Incus build
 * to be in the manifest, the artifacts dataset unmounted with its recorded
 * identity, and a preferences file that is absent or already holds the exact
 * pins. The content of the files is judged by the script inside the mount
 * window.
 */
function restorePlanOf(observation: Observation, target: IncusTarget, retained: Retained): RestorePlan | RefusedPlan {
  const version = versionOf(retained.baseline.packages)
  if (version === null) {
    return { kind: 'refused', reasons: ['The recorded Incus packages do not share one version.'] }
  }
  const reasons = artifactsReasons(observation, target)
  const absent = REQUIRED_PACKAGES.filter(
    name => !retained.artifacts.some(entry => entry.name === name && entry.version === version),
  )
  if (absent.length > 0) {
    reasons.push(`The retained package files do not hold the recorded ${absent.join(' and ')} ${version}.`)
  }
  const sha256 = sha256Of(repositoryPreferences(version))
  if (!fits(observation.repository.preferences, sha256)) {
    reasons.push(
      'The Qiln Incus preferences file exists but does not hold the recorded exact package pins, and Qiln never overwrites it.',
    )
  }
  if (reasons.length > 0) {
    return { kind: 'refused', reasons }
  }
  return {
    kind: 'restore',
    pool: target.pool,
    guid: target.guid,
    datasets: target.datasets,
    manifest: retained.artifacts,
    preferences: { version, sha256 },
  }
}

/**
 * Pure decision over one observation: the software stage first, then, once the
 * recorded pool is imported and its state dataset mounted, the capture or
 * restore, the open, the initialization, and socket access. Each stage needs its
 * own approval and a fresh inspection before the next. The toolchain floors, the
 * state directory, and the subordinate-ID allocations are judged before the
 * open, so a host that cannot be opened is refused before anything is installed.
 * A restore is planned before the state and allocation checks, because a package
 * script may create the root allocation that they look for.
 *
 * A fresh installation is never opened before its installed package files were
 * captured on the artifacts dataset, and a running daemon without that capture
 * is refused, because Qiln did not open it. A recorded installation
 * (`target.retained`) whose packages are missing restores its retained files
 * first, and is then reopened with its recorded software, root ranges, and
 * metadata. It is never initialized or opened as a fresh one.
 *
 * The open is planned whenever the daemon service is not running, including
 * after a reboot or a release. It carries the storage-identity guard when its
 * files are not all in place. A running daemon without the guard is refused,
 * because installing it then would protect nothing until the next start.
 * `progress.retained` is the preseed of an earlier verified initialization or
 * preserved open: a running daemon with a matching baseline proceeds to access,
 * and any drift, including from the recorded software, is refused.
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
  const approved = guardOf(target)
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
    fits(guard.expectation, approved.expectation.sha256),
    'The Qiln Incus expectation file exists but does not hold the approved identities, and Qiln never overwrites it.',
  )
  expect(
    fits(guard.check, approved.check.sha256),
    'The Qiln Incus startup check exists but does not hold the approved bytes, and Qiln never overwrites it.',
  )
  expect(
    fits(guard.dropIn, approved.dropIn.sha256),
    'The Qiln Incus service drop-in exists but does not hold the approved bytes, and Qiln never overwrites it.',
  )
  refusals.push(...toolchainReasons(observation))
  if (refusals.length > 0) {
    return { kind: 'refused', reasons: refusals }
  }
  if (target.retained !== null && compareSoftware(target.retained.baseline, observation).kind === 'missing') {
    return restorePlanOf(observation, target, target.retained)
  }
  if (api === null) {
    refusals.push(
      ...stateMountReasons(observation, target),
      ...stateReasons(observation, target.retained !== null),
      ...allocationReasons(observation, target.retained?.baseline.allocations ?? null),
    )
  }
  if (refusals.length > 0) {
    return { kind: 'refused', reasons: refusals }
  }
  if (target.retained === null && progress.artifacts === null) {
    return api === null
      ? capturePlanOf(observation, target, progress)
      : {
          kind: 'refused',
          reasons: ['The Incus daemon is running although Qiln never captured its package files, and Qiln does not adopt a daemon it did not open.'],
        }
  }
  const guarded = guard.expectation.kind === 'file' && guard.check.kind === 'file' && guard.dropIn.kind === 'file'
  if (api === null) {
    return {
      kind: 'open',
      pool: target.pool,
      guid: target.guid,
      datasets: target.datasets,
      guard: {
        expectation: { sha256: approved.expectation.sha256 },
        check: { sha256: approved.check.sha256 },
        dropIn: { sha256: approved.dropIn.sha256 },
      },
      install: !guarded,
      retained: target.retained,
    }
  }
  if (!guarded) {
    return {
      kind: 'refused',
      reasons: ['The Incus daemon is running without the storage-identity guard, and Qiln never installs the guard under a running daemon.'],
    }
  }
  if (progress.retained !== null) {
    const drift = baselineDrift(observation, target, progress.retained, progress.baseline)
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
 * - Units that are all positively inactive need nothing only when a verified
 *   release is already recorded after the last opening. Without that evidence
 *   they are refused, because removal never starts Incus: prepare reopens the
 *   recorded installation first.
 * - Otherwise the instance inventory is frozen, so the workload step can refuse
 *   any difference, and the daemon is released after it. Ephemeral instances are
 *   refused, because stopping them deletes them.
 * The pool stays imported, because the separate ZFS export owns exporting.
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
            'Every Incus unit is inactive, but no verified release is recorded after the last opening. Removal never starts Incus; run prepare to reopen the recorded installation, then remove to release it.',
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
