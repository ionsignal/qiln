import { ARCHITECTURES, EXCLUDED_PACKAGES, INCUS_SPEC, REQUIRED_PACKAGES, packagePins, type IncusAction } from './spec'
import { atLeast, compareSoftware } from './baseline'
import { readPreseed, type PreseedDocument } from './preseed'
import { STATE_MOUNTPOINT } from '../mount'
import { datasetNamesOf } from '../zfs/spec'
import {
  identityOf,
  instanceKey,
  type Api,
  type ApprovedPlan,
  type InstanceRef,
  type Observation,
  type PoolTarget,
  type Retained,
} from './types'

const ADDRESS_KEY = /^core\..+_address$/

type File = Observation['guard']['check']

function covers(actual: Record<string, string>, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value)
}

function holds(file: File, sha256: string): boolean {
  return file.kind === 'file' && file.sha256 === sha256
}

/**
 * Whether a candidate's source row names the approved repository.
 */
export function fromRepository(source: string): boolean {
  return source.startsWith(`${INCUS_SPEC.repository.uri} `)
}

/**
 * Every required package is listed from the approved repository, which is what
 * a refreshed package list looks like. This does not establish that the exact
 * pins are available; the package planner checks those separately.
 */
export function listed(observation: Observation): boolean {
  const { candidates } = observation.repository
  return REQUIRED_PACKAGES.every(name =>
    candidates.some(candidate => candidate.package === name && fromRepository(candidate.source)),
  )
}

export function excludedInstalled(observation: Observation): string[] {
  return observation.packages.filter(item => EXCLUDED_PACKAGES.includes(item.name)).map(item => item.name)
}

/**
 * Full package versions and native architectures must match, not merely the
 * daemon's upstream version label.
 */
function packagesPinned(observation: Observation): boolean {
  const architecture = ARCHITECTURES.find(name => name === observation.system.packageArchitecture)
  return (
    architecture !== undefined &&
    packagePins(architecture).every(pin =>
      observation.packages.some(
        installed =>
          installed.name === pin.name &&
          installed.version === pin.version &&
          installed.architecture === pin.architecture,
      ),
    )
  )
}

/**
 * Absence of a pool is evidence only when the pool listing could run, so an
 * unavailable listing never matches.
 */
export function poolImported(observation: Observation, pool: string, guid: string): boolean {
  const found = observation.zfs.pool
  return observation.zfs.available && found !== null && found.name === pool && found.guid === guid
}

/**
 * Every Incus unit is positively reported inactive, so nothing can answer on
 * the Incus sockets. An empty or incomplete service list is not evidence.
 */
export function quiescent(observation: Observation): boolean {
  return INCUS_SPEC.units.every(unit =>
    observation.services.some(service => service.unit === unit && service.activation === 'inactive'),
  )
}

/**
 * The Incus units that are masked, and whether the mask is runtime-only, which
 * does not survive a reboot.
 */
export function maskedUnits(observation: Observation): { unit: string; runtime: boolean }[] {
  return observation.services.flatMap(({ unit, load, enablement }) =>
    load === 'masked' || enablement === 'masked' || enablement === 'masked-runtime'
      ? [{ unit, runtime: enablement === 'masked-runtime' }]
      : [],
  )
}

/**
 * Every Incus unit is persistently masked, so nothing can start it until it is
 * unmasked. A runtime mask does not survive a reboot and does not count.
 */
export function closed(observation: Observation): boolean {
  const masked = maskedUnits(observation)
  return INCUS_SPEC.units.every(unit => masked.some(item => item.unit === unit && !item.runtime))
}

/**
 * The Incus units that are running or starting, which a mask would not stop.
 */
export function activeUnits(observation: Observation): string[] {
  return observation.services
    .filter(({ activation }) => activation === 'active' || activation === 'activating' || activation === 'reloading')
    .map(({ unit }) => unit)
}

/**
 * A package script must leave the host as it found it: every Incus unit still
 * persistently masked and inactive, and the AppArmor restriction not weakened.
 * The package maintainer scripts run as root and can undo a mask, so this is
 * detected here and never assumed. A restriction that could not be read is not
 * judged, because the key is absent without AppArmor.
 */
function stillClosed(observation: Observation): boolean {
  return closed(observation) && quiescent(observation) && observation.sysctl.apparmor !== '0'
}

/**
 * The units that the open step unmasks and starts are loaded and active.
 */
function running(observation: Observation): boolean {
  return INCUS_SPEC.open.units.every(unit =>
    observation.services.some(
      service => service.unit === unit && service.load === 'loaded' && service.activation === 'active',
    ),
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
 * The running kernel must meet the upstream floor. An unreadable version never
 * meets it.
 */
export function kernelReasons(observation: Observation): string[] {
  const { kernel } = observation.system
  const { kernel: minimum } = INCUS_SPEC.floors
  return atLeast(kernel, minimum) ? [] : [`The running kernel ${kernel} does not meet the required ${minimum}.`]
}

/**
 * ZFS must meet the upstream floors. A version that could not be determined
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

/**
 * Daemon-level conditions that hold both for a fresh and an initialized
 * baseline: the Qiln-required API capability, a standalone server, a supported
 * LXC version, and no remote listener.
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
 * Every way an observation departs from the approved prepared configuration.
 * Empty means the configuration holds. This one function backs both `ready` and
 * the verification of `initialize`, so they cannot disagree. Instances and
 * images are deliberately not part of it: workloads are expected after
 * initialization, and only the first initialization requires an empty
 * inventory. The default profile is not part of it either, because preparation
 * neither populates nor modifies it. Socket access is deliberately not part of
 * it: it is a later stage with its own plan and verification.
 */
export function baselineDrift(observation: Observation, target: PoolTarget, document: PreseedDocument): string[] {
  const { api } = observation
  if (api === null) {
    return ['The Incus API could not be read, because the daemon service is not running.']
  }
  const reasons = [
    ...kernelReasons(observation),
    ...toolchainReasons(observation),
    ...daemonReasons(observation, api),
    ...stateMountReasons(observation, target),
  ]
  const check = (passed: boolean, reason: string) => {
    if (!passed) {
      reasons.push(reason)
    }
  }
  const [pool] = document.storage_pools
  const [network] = document.networks
  check(
    packagesPinned(observation),
    'The required Incus packages do not match the exact selected versions and native architecture.',
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
 * The instances are exactly the approved inventory, and each one is stopped,
 * not ephemeral, and has its local `boot.autostart` set to false, so the
 * setting is the effective one whatever the profiles say. A daemon that cannot
 * be read proves none of it.
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
 * Closing is verified by the persistent masks and the approved sysctl override
 * bytes. The guard is verified by the approved file bytes alone, because it may
 * legitimately run once the host is open. The package install is verified only
 * if the host is still closed, because a package script can undo the masks or
 * weaken the AppArmor restriction. An open is verified by the startup check,
 * the recorded state mount, the exact package pins, and the running daemon
 * units, and, for a preserved installation, by the retained identity and
 * configuration. An initialization is judged against the preseed bytes retained
 * in its plan. An access grant is judged by the account database, which does not
 * show that SSH forwarding works. The workload stop is judged while the daemon
 * still answers, and the release only once every unit is inactive and
 * persistently masked.
 */
export function verify(action: IncusAction, plan: ApprovedPlan, observation: Observation): boolean {
  const { guard } = observation
  switch (action) {
    case 'close':
      return plan.kind === 'close' && closed(observation) && holds(observation.sysctl.override, plan.sysctl.sha256)
    case 'guard':
      return (
        plan.kind === 'guard' &&
        holds(guard.expectation, plan.expectation.sha256) &&
        holds(guard.check, plan.check.sha256) &&
        holds(guard.dropIn, plan.dropIn.sha256)
      )
    case 'add-repository':
      return (
        plan.kind === 'repository' &&
        holds(observation.repository.key, plan.key.sha256) &&
        holds(observation.repository.source, plan.source.sha256) &&
        holds(observation.repository.preferences, plan.preferences.sha256)
      )
    case 'refresh-lists':
      return (
        plan.kind === 'repository' &&
        holds(observation.repository.key, plan.key.sha256) &&
        holds(observation.repository.source, plan.source.sha256) &&
        holds(observation.repository.preferences, plan.preferences.sha256) &&
        listed(observation)
      )
    case 'install-packages':
      return (
        plan.kind === 'packages' &&
        packagesPinned(observation) &&
        stillClosed(observation) &&
        plan.install.every(change =>
          observation.packages.some(
            found =>
              found.name === change.name &&
              found.version === change.version &&
              found.architecture === change.architecture,
          ),
        )
      )
    case 'open':
      return (
        plan.kind === 'open' &&
        holds(guard.check, plan.check.sha256) &&
        stateMountReasons(observation, plan).length === 0 &&
        packagesPinned(observation) &&
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
        quiescent(observation) &&
        closed(observation) &&
        poolImported(observation, plan.pool, plan.guid) &&
        observation.zfs.datasets.every(dataset => !dataset.mounted || dataset.name === datasetNamesOf(plan.pool).state)
      )
  }
}
