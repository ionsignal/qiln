import { EXCLUDED_PACKAGES, INCUS_SPEC, REQUIRED_PACKAGES, type IncusAction } from './spec'
import { readPreseed, type PreseedDocument } from './preseed'
import type { Api, ApprovedPlan, IncusTarget, Observation } from './types'

const ADDRESS_KEY = /^core\..+_address$/

function covers(actual: Record<string, string>, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value)
}

function same(actual: Record<string, string>, expected: Record<string, string>): boolean {
  return covers(actual, expected) && Object.keys(actual).length === Object.keys(expected).length
}

function sameDevices(actual: Record<string, Record<string, string>>, expected: Record<string, Record<string, string>>) {
  return (
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([name, device]) => {
      const found = actual[name]
      return found !== undefined && same(found, device)
    })
  )
}

/**
 * Whether a candidate's source row names the approved repository.
 */
export function fromRepository(source: string): boolean {
  return source.startsWith(`${INCUS_SPEC.repository.uri} `)
}

/**
 * Every required package is listed from the approved repository, which is what
 * a refreshed package list looks like. Existence of the files alone is not.
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
 * Absence of a pool is evidence only when the pool listing could run, so an
 * unavailable listing never matches.
 */
export function poolImported(observation: Observation, pool: string, guid: string): boolean {
  const found = observation.zfs.pool
  return observation.zfs.available && found !== null && found.name === pool && found.guid === guid
}

/**
 * Every Incus unit is positively reported inactive, so nothing can answer on the
 * Incus sockets. An empty or incomplete service list is not evidence.
 */
export function quiescent(observation: Observation): boolean {
  return INCUS_SPEC.units.every(unit =>
    observation.services.some(service => service.unit === unit && service.activation === 'inactive'),
  )
}

/**
 * Daemon-level conditions that hold both for a fresh and an initialized
 * baseline: the Qiln-required API capability, and no remote listener.
 */
export function daemonReasons(observation: Observation, api: Api): string[] {
  const reasons: string[] = []
  if (!INCUS_SPEC.requiredExtensions.every(name => api.server.extensions.includes(name))) {
    reasons.push('The Incus server does not advertise a required API extension.')
  }
  if (Object.entries(api.server.config).some(([key, value]) => ADDRESS_KEY.test(key) && value !== '')) {
    reasons.push('A listener address is configured in the Incus server settings.')
  }
  if (observation.listeners.length > 0) {
    reasons.push('The Incus daemon is listening on a TCP address.')
  }
  return reasons
}

/**
 * Every way an observation departs from the approved initialized baseline.
 * Empty means the baseline holds. This one function backs both `ready` and the
 * verification of `initialize`, so they cannot disagree.
 */
export function baselineDrift(observation: Observation, target: IncusTarget, document: PreseedDocument): string[] {
  const { api } = observation
  if (api === null) {
    return ['The Incus API could not be read, because the daemon sockets are not active.']
  }
  const reasons = daemonReasons(observation, api)
  const check = (passed: boolean, reason: string) => {
    if (!passed) {
      reasons.push(reason)
    }
  }
  const [pool] = document.storage_pools
  const [network] = document.networks
  const [profile] = document.profiles
  check(
    REQUIRED_PACKAGES.every(name => observation.packages.some(item => item.name === name)),
    'The approved Incus packages are not all installed.',
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
    api.profiles.some(
      found =>
        found.name === profile.name &&
        same(found.config, profile.config) &&
        sameDevices(found.devices, profile.devices),
    ),
    'The default profile does not match the approved configuration.',
  )
  check(
    api.projects.length === 1 && api.projects.every(name => name === 'default'),
    'Incus has projects other than default.',
  )
  check(api.instances.length === 0, 'Incus already holds instances.')
  check(api.images === 0, 'Incus already holds images.')
  check(observation.system.ipForward, 'IPv4 forwarding is not enabled on the host.')
  return reasons
}

/**
 * Pure check of one step's approved result against a fresh observation. A step
 * is verified only when the host agrees, never because its script exited zero.
 * An initialization is judged against the preseed bytes retained in its plan.
 */
export function verify(action: IncusAction, plan: ApprovedPlan, observation: Observation): boolean {
  switch (action) {
    case 'add-repository':
      return (
        plan.kind === 'repository' &&
        observation.repository.key.kind === 'file' &&
        observation.repository.key.sha256 === plan.key.sha256 &&
        observation.repository.source.kind === 'file' &&
        observation.repository.source.sha256 === plan.source.sha256
      )
    case 'refresh-lists':
      return plan.kind === 'repository' && listed(observation)
    case 'install-packages':
      return (
        plan.kind === 'packages' &&
        plan.install.every(change =>
          observation.packages.some(
            found =>
              found.name === change.name &&
              found.version === change.version &&
              found.architecture === change.architecture,
          ),
        )
      )
    case 'initialize': {
      if (plan.kind !== 'initialize') {
        return false
      }
      const document = readPreseed(plan.preseed.yaml)
      return (
        document !== null && baselineDrift(observation, { pool: plan.pool, guid: plan.guid }, document).length === 0
      )
    }
    case 'release':
      return (
        plan.kind === 'release' &&
        quiescent(observation) &&
        poolImported(observation, plan.pool, plan.guid) &&
        observation.zfs.datasets.every(dataset => !dataset.mounted)
      )
  }
}
