import { InstallerError } from '../diagnostic/error'
import { phase } from '../aws/deployment/facts'
import { requireStorageReleased, retainedPreseedBytes } from '../aws/deployment/incus/facts'
import { requirePoolReleased } from '../aws/deployment/zfs/facts'
import { sameJson } from '../json'
import { requireSettled } from './journal/facts'
import { planOf, type PlanRequest } from './plan'
import { pinned, type InstallationState } from './state'
import type { Deployment } from '../aws/deployment/types'
import type { IncusRecord } from '../aws/deployment/incus/types'
import type { ZfsRecord } from '../aws/deployment/zfs/types'
import type { ConfigureEvidence } from './journal/types'
import type { Observation } from './observe'
import type { InstallationRecord } from './records'

/**
 * One deployment of a retained-volume chain with its preparation evidence.
 * Chains are listed newest first, so the selected deployment comes first.
 */
export interface Link {
  deployment: Deployment
  zfs: ZfsRecord | null
  incus: IncusRecord | null
}

export function refusal(installation: string, reason: string, retry: string): InstallerError {
  return new InstallerError({
    code: 'INSTALLATION_REASSIGNMENT_REFUSED',
    facts: [
      ['Installation', installation],
      ['Reason', reason],
    ],
    retry,
  })
}

/**
 * Every deployment from the assigned host up to the one before the selected
 * deployment handed its volume to the next, was released, exported, and
 * removed.
 */
function requireHandoffs(links: readonly Link[], assigned: number, installation: string, retry: string): void {
  for (let age = 1; age <= assigned; age++) {
    const { deployment, zfs, incus } = links[age]
    if (phase(deployment) !== 'handed-off' || deployment.handoff?.to !== links[age - 1].deployment.id) {
      throw refusal(
        installation,
        `Deployment ${deployment.id} did not verifiably hand its retained volume to the next deployment of the chain.`,
        retry,
      )
    }
    requirePoolReleased(zfs, deployment.id)
    requireStorageReleased(incus, deployment.id)
  }
}

function poolOf({ zfs }: Link) {
  const pool = zfs?.pool
  return pool === undefined || pool === null ? null : { name: pool.name, guid: pool.guid, datasets: pool.datasets }
}

/**
 * The same Incus server identity, retained preseed, and ZFS pool. Missing
 * evidence on either side never matches.
 */
function sameStorage(left: Link, right: Link): boolean {
  const certificate = left.incus?.identity?.certificateFingerprint
  const preseed = retainedPreseedBytes(left.incus)?.sha256
  const pool = poolOf(left)
  return (
    certificate !== undefined &&
    preseed !== undefined &&
    pool !== null &&
    certificate === right.incus?.identity?.certificateFingerprint &&
    preseed === retainedPreseedBytes(right.incus)?.sha256 &&
    sameJson(pool, poolOf(right))
  )
}

/**
 * Judges retained evidence only: the installation is a configured AWS one with
 * no unsettled step, its assigned host is an earlier deployment of the
 * selected deployment's volume chain, every hop released and handed off the
 * volume, and the selected deployment holds the same preserved installation.
 * The live target is judged separately by `requireMatching`.
 */
export function requireAssignable(
  record: InstallationRecord,
  evidence: ConfigureEvidence | null,
  links: readonly Link[],
  retry: string,
): InstallationState {
  const { host, name } = record
  if (host.kind !== 'aws') {
    throw refusal(name, 'A local installation is never reassigned to an AWS deployment.', retry)
  }
  const installation = pinned(record)
  if (installation === null) {
    throw refusal(name, 'No image is pinned, so the installation was never configured.', retry)
  }
  const assigned = links.findIndex(({ deployment }) => deployment.id === host.deployment)
  if (assigned < 1) {
    throw refusal(name, 'The assigned deployment is not an earlier deployment of the selected deployment’s volume chain.', retry)
  }
  requireSettled(evidence, name, retry)
  requireHandoffs(links, assigned, name, retry)
  if (!sameStorage(links[assigned], links[0])) {
    throw refusal(
      name,
      'The selected deployment does not hold the same Incus server identity, retained preseed, and ZFS pool as the assigned host.',
      retry,
    )
  }
  return installation
}

/**
 * Uses planning only as a predicate: the live target must already match the
 * installation, so reassignment never repairs or completes a configuration.
 */
export function requireMatching(
  observation: Observation,
  request: PlanRequest,
  installation: string,
  retry: string,
): void {
  if (observation.credentials === 'absent') {
    throw refusal(installation, 'The retained local credential set is absent, so the instance credentials cannot be compared.', retry)
  }
  const plan = planOf(observation, request)
  const changes: [boolean, string][] = [
    [plan.image.import || plan.image.alias || plan.image.replace !== null, 'the orchestrator image'],
    [plan.pin, 'the image pin'],
    [plan.network, 'the managed network'],
    [plan.volume, 'the PostgreSQL volume'],
    [plan.instance, 'the orchestrator instance'],
    [plan.credentials !== 'reuse', 'the local credential set'],
    [plan.deliver, 'the instance credentials'],
  ]
  const pending = changes.filter(([needed]) => needed).map(([, label]) => label)
  if (pending.length > 0) {
    throw refusal(
      installation,
      `The target does not yet match the installation and would need: ${pending.join(', ')}. Reassignment never changes it.`,
      retry,
    )
  }
}
