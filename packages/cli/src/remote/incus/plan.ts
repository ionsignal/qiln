import { sha256Of } from './recipe'
import { ARCHITECTURES, INCUS_SPEC, REQUIRED_PACKAGES, repositorySource } from './spec'
import {
  baselineDrift,
  daemonReasons,
  excludedInstalled,
  fromRepository,
  listed,
  poolImported,
  quiescent,
} from './verify'
import { transactionViolations } from '../apt'
import type { Preseed, PreseedDocument } from './preseed'
import type {
  AccessPlan,
  Api,
  IncusTarget,
  Observation,
  PreparationPlan,
  ReadyPlan,
  RefusedPlan,
  ReleasePlan,
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
 * Reasons that this is not a pristine Incus installation on a pool with no
 * Incus data. Initialization merges into existing state, so anything but a
 * blank daemon is refused, and retained Incus data needs restoration, which
 * is not supported.
 */
function freshReasons(observation: Observation, api: Api, target: IncusTarget): string[] {
  const reasons: string[] = []
  const expect = (passed: boolean, reason: string) => {
    if (!passed) {
      reasons.push(reason)
    }
  }
  const { name: bridge, subnet } = INCUS_SPEC.network
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
    observation.zfs.datasets.length === 1 && observation.zfs.datasets.every(dataset => dataset.name === target.pool),
    `The pool ${target.pool} already holds datasets, which indicates retained Incus data. Restoring it is not supported, and Qiln never adopts or wipes it.`,
  )
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
 * Pure decision over one observation, in stages: the repository, then the
 * packages, then initialization, then socket access. Each stage returns its own
 * plan, so each needs its own approval and a fresh inspection before the next.
 * Refusals are collected rather than short-circuited within a stage. `retained`
 * is the preseed document of an earlier verified initialization, in which case
 * a matching baseline proceeds to the access stage and any drift from it is
 * refused, never adopted or repaired. Without it, only a pristine daemon is
 * initialized.
 */
export function planOf(
  observation: Observation,
  target: IncusTarget,
  preseed: Preseed,
  retained: PreseedDocument | null,
): PreparationPlan {
  const { system, repository, packages, transaction, api } = observation
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
  expect(architecture !== undefined, 'The host package architecture is neither amd64 nor arm64.')
  expect(
    poolImported(observation, target.pool, target.guid),
    `The recorded pool ${target.pool} (GUID ${target.guid}) is not imported on the host.`,
  )
  const excluded = excludedInstalled(observation)
  expect(
    excluded.length === 0,
    `Unsupported Incus packages are installed (${excluded.join(', ')}), and Qiln does not remove them.`,
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
  const add = repository.key.kind === 'absent' || repository.source.kind === 'absent'
  if (add || !listed(observation)) {
    return {
      kind: 'repository',
      architecture,
      add,
      key: { url: keyUrl, sha256: keySha256 },
      source: { sha256: sourceDigest },
    }
  }
  const installed = new Set(packages.map(item => item.name))
  const missing = REQUIRED_PACKAGES.filter(name => !installed.has(name))
  if (missing.length > 0) {
    refusals.push(
      ...transactionViolations(transaction, {
        missing,
        architecture: system.packageArchitecture,
        maximum: INCUS_SPEC.maximumInstalls,
        label: 'required Incus',
      }),
    )
    if (transaction !== null) {
      expect(
        transaction.installs
          .filter(change => REQUIRED_PACKAGES.includes(change.name))
          .every(change =>
            repository.candidates.some(
              candidate =>
                candidate.package === change.name &&
                candidate.version === change.version &&
                fromRepository(candidate.source),
            ),
          ),
        'APT planned an Incus package version that the approved repository does not list.',
      )
    }
    return refusals.length > 0 || transaction === null ? refused() : { kind: 'packages', install: transaction.installs }
  }
  if (api === null) {
    return refused(['The Incus daemon sockets are not active, so its state cannot be read. Qiln does not start units.'])
  }
  if (retained !== null) {
    const drift = baselineDrift(observation, target, retained)
    return drift.length === 0 ? accessPlan(observation, target) : refused(drift)
  }
  const conflicts = [...daemonReasons(observation, api), ...freshReasons(observation, api, target)]
  if (conflicts.length > 0) {
    return refused(conflicts)
  }
  return {
    kind: 'initialize',
    pool: target.pool,
    guid: target.guid,
    preseed: { yaml: preseed.yaml, sha256: preseed.sha256 },
  }
}

/**
 * Decides what Incus needs before the ZFS export that precedes AWS removal.
 * Incus units that are not all positively inactive are released: instances are
 * shut down in order, then the daemon and its sockets are stopped. The pool
 * must stay imported, because the separate ZFS export owns exporting.
 */
export function releasePlanOf(observation: Observation, target: IncusTarget): RefusedPlan | ReleasePlan | StoppedPlan {
  if (quiescent(observation)) {
    return { kind: 'stopped' }
  }
  if (!poolImported(observation, target.pool, target.guid)) {
    return {
      kind: 'refused',
      reasons: [`The recorded pool ${target.pool} (GUID ${target.guid}) is not imported on the host.`],
    }
  }
  return {
    kind: 'release',
    pool: target.pool,
    guid: target.guid,
  }
}
