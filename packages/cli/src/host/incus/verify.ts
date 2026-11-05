import { EXCLUDED_PACKAGES, INCUS_SPEC, REQUIRED_PACKAGES, type IncusAction } from './spec'
import { ARTIFACTS_MOUNTPOINT, STATE_MOUNTPOINT } from '../mount'
import { atLeast, compareSoftware } from './baseline'
import { manifestOf } from './artifacts'
import { readPreseed, type PreseedDocument } from './preseed'
import { datasetNamesOf } from '../zfs/spec'
import {
  identityOf,
  instanceKey,
  repositoryOf,
  type Api,
  type ApprovedPlan,
  type Baseline,
  type InstanceRef,
  type Observation,
  type OpenPlan,
  type PackageChange,
  type PoolTarget,
  type RepositoryPlan,
  type Retained,
} from './types'

type File = Observation['guard']['check']

const ADDRESS_KEY = /^core\..+_address$/

function covers(actual: Record<string, string>, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value)
}

function holds(file: File, sha256: string): boolean {
  return file.kind === 'file' && file.sha256 === sha256
}

function guardInPlace({ guard }: Observation, plan: OpenPlan): boolean {
  return (
    holds(guard.expectation, plan.guard.expectation.sha256) &&
    holds(guard.check, plan.guard.check.sha256) &&
    holds(guard.dropIn, plan.guard.dropIn.sha256)
  )
}

function installedAs(observation: Observation, changes: readonly PackageChange[]): boolean {
  return changes.every(change =>
    observation.packages.some(
      found =>
        found.name === change.name && found.version === change.version && found.architecture === change.architecture,
    ),
  )
}

function repositoryInPlace(observation: Observation, plan: RepositoryPlan): boolean {
  const { key, source } = observation.repository
  return holds(key, plan.key.sha256) && holds(source, plan.source.sha256)
}

function incusInstalled(observation: Observation): boolean {
  const pins = installedPins(observation)
  const [first] = pins
  return (
    first !== undefined &&
    pins.length === REQUIRED_PACKAGES.length &&
    pins.every(pin => pin.version === first.version && pin.architecture === observation.system.packageArchitecture)
  )
}

function softwareReasons(observation: Observation, baseline: Baseline | null): string[] {
  if (baseline === null) {
    return []
  }
  const comparison = compareSoftware(baseline, observation)
  switch (comparison.kind) {
    case 'match':
      return []
    case 'differs':
      return comparison.reasons
    case 'missing':
      return ['The recorded Incus packages are not all installed.']
  }
}

function stillClosed(observation: Observation): boolean {
  return closed(observation) && observation.sysctl.apparmor !== '0'
}

function running(observation: Observation): boolean {
  return INCUS_SPEC.open.units.every(unit =>
    observation.services.some(
      service => service.unit === unit && service.load === 'loaded' && service.activation === 'active',
    ),
  )
}

/**
 * The LXC version that the running daemon reports must meet the upstream floor.
 * A daemon that reports none never passes.
 */
function lxcReasons(api: Api): string[] {
  const { lxc: minimum } = INCUS_SPEC.floors
  const { lxc } = api.server
  if (lxc === null) {
    return ['The Incus daemon did not report an LXC driver version.']
  }
  return atLeast(lxc, minimum) ? [] : [`The Incus daemon reports LXC ${lxc}, which does not meet the required ${minimum}.`]
}

export function fromRepository(source: string): boolean {
  return source.startsWith(`${INCUS_SPEC.repository.uri} `)
}

export function listed(observation: Observation): boolean {
  const { candidates } = observation.repository
  return REQUIRED_PACKAGES.every(name =>
    candidates.some(candidate => candidate.package === name && fromRepository(candidate.source)),
  )
}

export function excludedInstalled(observation: Observation): string[] {
  return observation.packages.filter(item => EXCLUDED_PACKAGES.includes(item.name)).map(item => item.name)
}

export function installedPins(observation: Observation): PackageChange[] {
  return observation.packages.filter(item => REQUIRED_PACKAGES.includes(item.name))
}

export function poolImported(observation: Observation, pool: string, guid: string): boolean {
  const found = observation.zfs.pool
  return observation.zfs.available && found !== null && found.name === pool && found.guid === guid
}

export function quiescent(observation: Observation): boolean {
  return INCUS_SPEC.units.every(unit =>
    observation.services.some(service => service.unit === unit && service.activation === 'inactive'),
  )
}

export function maskedUnits(observation: Observation): { unit: string; runtime: boolean }[] {
  return observation.services.flatMap(({ unit, enablement }) =>
    enablement === 'masked' || enablement === 'masked-runtime'
      ? [{ unit, runtime: enablement === 'masked-runtime' }]
      : [],
  )
}

export function closed(observation: Observation): boolean {
  const masked = maskedUnits(observation)
  return (
    INCUS_SPEC.units.every(unit => masked.some(item => item.unit === unit && !item.runtime)) &&
    quiescent(observation)
  )
}

/**
 * Every way the mounted state differs from the recorded identities: both
 * datasets must carry their recorded GUIDs, and the state dataset must be the
 * filesystem that the kernel mount table shows at the state directory. A missing
 * kernel entry is a missing observation and never counts as agreement.
 */
export function stateMountReasons(observation: Observation, target: PoolTarget): string[] {
  const names = datasetNamesOf(target.pool)
  const state = observation.zfs.topLevel.find(dataset => dataset.name === names.state)
  const incus = observation.zfs.topLevel.find(dataset => dataset.name === names.incus)
  const mount = observation.stateMount
  const reasons: string[] = []
  if (state === undefined || state.type !== 'filesystem' || state.guid !== target.datasets.state) {
    reasons.push(`The dataset ${names.state} was not found with its recorded GUID ${target.datasets.state}.`)
  }
  if (incus === undefined || incus.type !== 'filesystem' || incus.guid !== target.datasets.incus) {
    reasons.push(`The dataset ${names.incus} was not found with its recorded GUID ${target.datasets.incus}.`)
  }
  if (
    state?.mounted !== true ||
    mount === null ||
    mount.source !== names.state ||
    mount.fstype !== 'zfs' ||
    mount.target !== STATE_MOUNTPOINT
  ) {
    reasons.push(`${names.state} is not the filesystem that the kernel mount table shows at ${STATE_MOUNTPOINT}.`)
  }
  return reasons
}

/**
 * Every way the artifacts dataset is not ready for, or has not returned from, a
 * mount window: it must carry its recorded GUID, its local mountpoint and
 * canmount=noauto, be unmounted, and nothing may be mounted at its mountpoint.
 * A missing kernel entry is a missing observation, as for the state mount.
 */
export function artifactsReasons(observation: Observation, target: PoolTarget): string[] {
  const name = datasetNamesOf(target.pool).artifacts
  const dataset = observation.zfs.topLevel.find(item => item.name === name)
  const reasons: string[] = []
  if (dataset === undefined || dataset.type !== 'filesystem' || dataset.guid !== target.datasets.artifacts) {
    reasons.push(`The dataset ${name} was not found with its recorded GUID ${target.datasets.artifacts}.`)
  } else if (
    dataset.mountpoint.value !== ARTIFACTS_MOUNTPOINT ||
    dataset.mountpoint.source !== 'local' ||
    dataset.canmount.value !== 'noauto' ||
    dataset.canmount.source !== 'local'
  ) {
    reasons.push(`${name} does not have the local mountpoint ${ARTIFACTS_MOUNTPOINT} with canmount=noauto.`)
  } else if (dataset.mounted) {
    reasons.push(`${name} is mounted.`)
  }
  if (observation.artifactsMount !== null) {
    reasons.push(`Something is mounted at ${ARTIFACTS_MOUNTPOINT}.`)
  }
  return reasons
}

/**
 * The running kernel must meet the upstream floor. An unreadable version never
 * meets it.
 */
export function kernelReasons(observation: Observation): string[] {
  const { kernel } = observation.system
  const { kernel: minimum } = INCUS_SPEC.floors
  return atLeast(kernel, minimum) ? [] : [`The running kernel ${kernel} does not meet the required ${minimum}.`]
}

/**
 * ZFS must meet the upstream floors, and a version that could not be determined
 * never passes. The LXC version is judged from the running daemon instead.
 */
export function toolchainReasons(observation: Observation): string[] {
  const { floors } = INCUS_SPEC
  const { zfs, zfsModule } = observation.runtime
  const reasons: string[] = []
  const check = (subject: string, version: string | null, minimum: string) => {
    if (version === null) {
      reasons.push(`The ${subject} version could not be determined.`)
    } else if (!atLeast(version, minimum)) {
      reasons.push(`${subject} ${version} does not meet the required ${minimum}.`)
    }
  }
  check('ZFS userspace', zfs, floors.zfs)
  check('ZFS kernel module', zfsModule, floors.zfs)
  return reasons
}

/**
 * Daemon-level conditions that hold for both a fresh and an initialized
 * baseline: the required API capability, a standalone server, a supported LXC
 * version, and no remote listener.
 */
export function daemonReasons(observation: Observation, api: Api): string[] {
  const reasons: string[] = []
  if (!INCUS_SPEC.requiredExtensions.every(name => api.server.extensions.includes(name))) {
    reasons.push('The Incus server does not advertise a required API extension.')
  }
  if (api.server.clustered) {
    reasons.push('The Incus server is clustered, and only a standalone installation is supported.')
  }
  reasons.push(...lxcReasons(api))
  if (Object.entries(api.server.config).some(([key, value]) => ADDRESS_KEY.test(key) && value !== '')) {
    reasons.push('A listener address is configured in the Incus server settings.')
  }
  if (observation.listeners.length > 0) {
    reasons.push('The Incus daemon is listening on a TCP address.')
  }
  return reasons
}

/**
 * Every way an observation departs from the approved prepared configuration;
 * empty means it holds. It backs both `ready` and the verification of
 * `initialize`, so they cannot disagree. `baseline` is the recorded software,
 * when one exists, so drift from the recorded builds is reported too. Instances,
 * images, the default profile, and socket access are deliberately not part of
 * it.
 */
export function baselineDrift(
  observation: Observation,
  target: PoolTarget,
  document: PreseedDocument,
  baseline: Baseline | null = null,
): string[] {
  const { api } = observation
  if (api === null) {
    return ['The Incus API could not be read, because the daemon service is not running.']
  }
  const reasons = [
    ...kernelReasons(observation),
    ...toolchainReasons(observation),
    ...daemonReasons(observation, api),
    ...stateMountReasons(observation, target),
    ...softwareReasons(observation, baseline),
  ]
  const check = (passed: boolean, reason: string) => {
    if (!passed) {
      reasons.push(reason)
    }
  }
  const [pool] = document.storage_pools
  const [network] = document.networks
  check(
    incusInstalled(observation),
    'The required Incus packages are not installed at one version on the native architecture.',
  )
  check(
    poolImported(observation, target.pool, target.guid),
    `The recorded pool ${target.pool} (GUID ${target.guid}) is not imported on the host.`,
  )
  check(
    api.pools.length === 1 &&
      api.pools.every(
        found => found.name === pool.name && found.driver === pool.driver && covers(found.config, pool.config),
      ),
    'The Incus storage pool does not match the approved configuration.',
  )
  check(
    api.networks.some(
      found =>
        found.managed &&
        found.name === network.name &&
        found.type === network.type &&
        covers(found.config, network.config),
    ),
    'The managed bridge does not match the approved configuration.',
  )
  check(
    api.projects.length === 1 && api.projects.every(name => name === 'default'),
    'Incus has projects other than default.',
  )
  check(observation.system.ipForward, 'IPv4 forwarding is not enabled on the host.')
  return reasons
}

/**
 * The instances are exactly the approved inventory, and each is stopped, not
 * ephemeral, and has its local `boot.autostart` set to false, so the setting is
 * the effective one whatever the profiles say. A daemon that cannot be read
 * proves none of it.
 */
function workloadsStopped(observation: Observation, approved: readonly InstanceRef[]): boolean {
  const { api } = observation
  if (api === null) {
    return false
  }
  const wanted = new Set(approved.map(instanceKey))
  return (
    api.instances.length === approved.length &&
    api.instances.every(
      instance =>
        wanted.has(instanceKey(instance)) &&
        instance.status === 'Stopped' &&
        !instance.ephemeral &&
        instance.autostart === 'false',
    )
  )
}

/**
 * A preserved installation was reopened: its pinned software is the recorded
 * one, the server presents the retained certificate fingerprint as a standalone
 * server, the pool registration and bridge match the retained preseed, and every
 * instance is still stopped, because opening never starts workloads.
 */
function reopened(observation: Observation, target: PoolTarget, retained: Retained): boolean {
  const document = readPreseed(retained.preseed.yaml)
  const identity = identityOf(observation)
  return (
    document !== null &&
    compareSoftware(retained.baseline, observation).kind === 'match' &&
    identity !== null &&
    identity.certificateFingerprint === retained.identity.certificateFingerprint &&
    baselineDrift(observation, target, document).length === 0 &&
    (observation.api?.instances ?? []).every(instance => instance.status === 'Stopped')
  )
}

/**
 * Pure check of one step's approved result against a fresh observation. A step
 * is verified only when the host agrees, never because its script exited zero.
 * - Closing: persistent masks, positive inactivity, and the approved override.
 * - Repository steps: judged against the repository plan that the approved plan
 *   carries, whether it stands alone or follows a closing.
 * - Version pin: the preferences file holds the approved bytes, whether the plan
 *   installs from a repository or restores retained files.
 * - Guard: the approved file bytes alone, because it runs under the open
 *   approval before the daemon starts.
 * - Package install: only if the host is still closed, because a package
 *   script can undo the masks or weaken the AppArmor restriction, and only if
 *   every installed package file was kept in the staging directory with the
 *   size and SHA-256 that the repository index lists, so the capture that
 *   follows is known to have its files before any storage is touched.
 * - Capture: the artifacts dataset is back to unmounted with its recorded GUID
 *   and local properties, and nothing is mounted at its mountpoint. The copied
 *   content is verified by the script inside the mount window, because the
 *   unmounted dataset cannot be read here.
 * - Restore: every retained package is installed at its recorded version, the
 *   host is still closed, and the artifacts dataset is unmounted again. The
 *   retained content was verified by the script inside the mount window.
 * - Open: the guard files, the recorded state mount, the installed packages at
 *   one version, and the running daemon units, plus the retained identity and
 *   configuration for a preserved installation.
 * - Initialization: the preseed bytes retained in its plan.
 * - Access grant: the account database, which does not show that SSH forwarding
 *   works.
 * - Workload stop: while the daemon still answers. Release: once every unit is
 *   inactive and persistently masked.
 */
export function verify(action: IncusAction, plan: ApprovedPlan, observation: Observation): boolean {
  switch (action) {
    case 'close':
      return plan.kind === 'close' && closed(observation) && holds(observation.sysctl.override, plan.sysctl.sha256)
    case 'guard':
      return plan.kind === 'open' && guardInPlace(observation, plan)
    case 'add-repository': {
      const approved = repositoryOf(plan)
      return approved !== null && repositoryInPlace(observation, approved)
    }
    case 'refresh-lists': {
      const approved = repositoryOf(plan)
      return approved !== null && repositoryInPlace(observation, approved) && listed(observation)
    }
    case 'pin-versions':
      return (
        (plan.kind === 'packages' || plan.kind === 'restore') &&
        holds(observation.repository.preferences, plan.preferences.sha256)
      )
    case 'install-packages':
      return (
        plan.kind === 'packages' &&
        incusInstalled(observation) &&
        stillClosed(observation) &&
        installedAs(observation, plan.install) &&
        'manifest' in manifestOf(plan.install, observation.stage, observation.index)
      )
    case 'capture':
      return plan.kind === 'capture' && artifactsReasons(observation, plan).length === 0
    case 'restore':
      return (
        plan.kind === 'restore' &&
        incusInstalled(observation) &&
        stillClosed(observation) &&
        installedAs(observation, plan.manifest) &&
        artifactsReasons(observation, plan).length === 0
      )
    case 'open':
      return (
        plan.kind === 'open' &&
        guardInPlace(observation, plan) &&
        stateMountReasons(observation, plan).length === 0 &&
        incusInstalled(observation) &&
        running(observation) &&
        (plan.retained === null || reopened(observation, plan, plan.retained))
      )
    case 'initialize': {
      if (plan.kind !== 'initialize') {
        return false
      }
      const document = readPreseed(plan.preseed.yaml)
      return document !== null && baselineDrift(observation, plan, document).length === 0
    }
    case 'grant-access':
      return (
        plan.kind === 'access' &&
        observation.access.account === plan.account &&
        observation.access.groupExists &&
        observation.access.member
      )
    case 'stop-workloads':
      return plan.kind === 'release' && workloadsStopped(observation, plan.instances)
    case 'release':
      return (
        plan.kind === 'release' &&
        closed(observation) &&
        poolImported(observation, plan.pool, plan.guid) &&
        observation.zfs.datasets.every(dataset => !dataset.mounted || dataset.name === datasetNamesOf(plan.pool).state)
      )
  }
}
