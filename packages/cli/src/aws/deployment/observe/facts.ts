import { AWS_SPEC } from '../../spec'
import { deploymentName } from '../volume/alias'
import { expectation, matches } from './expect'
import { declined, refusals, settled, stateOf } from '../ledger/step'
import {
  creationPlan,
  creationsOf,
  launches,
  removalPlan,
  resourceId,
  resources,
  retained,
  unnamed,
  unreleased,
} from '../topology'
import type { Deployment } from '../types'
import type { DiagnosticFact } from '../../../diagnostic/error'

export type Phase =
  | 'approved'
  | 'unattempted'
  | 'unresolved'
  | 'rejected'
  | 'blocked'
  | 'returned'
  | 'uncertain'
  | 'partial'
  | 'created'
  | 'healthy'
  | 'removing'
  | 'removed'
  | 'retained'
  | 'handed-off'
  | 'absent'

/**
 * `retained` means nothing is unresolved, but a resource kept by design still
 * exists. It is distinct from `none`, because that resource keeps incurring
 * charges until it is deleted outside Qiln.
 */
export type Effects = 'none' | 'retained' | 'outstanding'
export type Verification = 'verified' | 'not-verified' | 'uncertain'
export interface Cleanup {
  status: 'not-needed' | 'eligible' | 'blocked'
  detail: string
}

const DESCRIPTIONS: Record<Phase, string> = {
  approved: 'creation approved; not attempted',
  unattempted: 'last mutation was not attempted; no mutating call was dispatched',
  unresolved: 'mutation fenced; outcome unresolved',
  rejected: 'last mutation was definitively rejected by the provider',
  blocked: 'removal blocked by dependencies',
  returned: 'response retained; not yet verified by observation',
  uncertain: 'outcome uncertain',
  partial: 'creation stopped after a verified step; deployment incomplete',
  created: 'provisioned; AWS health not verified',
  healthy: 'AWS provisioning and health verified',
  removing: 'removal partly verified; recorded resources remain',
  removed: 'all recorded resources removed and observed absent',
  retained: 'removal verified; resources retained by design remain and were not removed',
  'handed-off': 'removal verified; the retained data volume was handed off to a later deployment',
  absent: 'recorded resources observed absent',
}

export function phase(record: Deployment): Phase {
  const last = record.steps.at(-1)
  if (last === undefined) {
    return 'approved'
  }
  if (last.failure !== null) {
    return last.failure.outcome
  }
  if (last.verifiedAt === null) {
    return last.returned === null ? 'unresolved' : 'returned'
  }
  if (resources(record).length > 0 && unreleased(record).length === 0) {
    if (retained(record).length > 0) {
      return 'retained'
    }
    if (record.handoff !== null) {
      return 'handed-off'
    }
    return record.removals.length > 0 ? 'removed' : 'absent'
  }
  if (last.removal !== null) {
    return 'removing'
  }
  if (creationsOf(record.steps).length !== creationPlan(record.approval).length) {
    return 'partial'
  }
  return record.health === null ? 'created' : 'healthy'
}

export function describe(record: Deployment): string {
  return DESCRIPTIONS[phase(record)]
}

/**
 * The single wording for the administrative key. A binding discloses its
 * fingerprint, and neither case claims anything about the local files.
 */
export function keyDisclosure(record: Deployment): string {
  return record.adminKey === null
    ? 'no key recorded; partial files may exist'
    : `SHA256:${record.adminKey.fingerprint} recorded; local-file availability was not inspected`
}

/**
 * The single wording for the server's host-key pin. It is AWS-reported console
 * evidence, not an AWS-signed certificate or guest attestation.
 */
export function hostKeyDisclosure(record: Deployment): string {
  const { hostKey } = record
  return hostKey === null
    ? 'not retained'
    : `SHA256:${hostKey.fingerprint} (${hostKey.algorithm}) for ${hostKey.address} · AWS console evidence from ${hostKey.consoleAt}, retained ${hostKey.observedAt}; not guest attestation`
}

/**
 * The single wording for the data volume's origin and, once it happened, its
 * handoff. A reused volume keeps the tags of the deployment that created it.
 */
export function volumeDisclosure(record: Deployment): string {
  const { volume } = record.approval.host
  const source =
    volume.kind === 'reuse'
      ? `reuses ${volume.volumeId} from deployment ${volume.from}; its original tags are kept`
      : 'created by this deployment'
  return record.handoff === null
    ? source
    : `${source}; handed off to deployment ${record.handoff.to} at ${record.handoff.at}`
}

/**
 * The single wording for launch attempts, one per approved zone at most. A
 * declined attempt was definitely refused by AWS for lack of capacity in its
 * zone and launched nothing.
 */
export function launchDisclosure(record: Deployment): string {
  const { hostSlots, zones } = record.approval.host.plan
  const attempts = launches(record).map((step, index) => {
    const zone = zones[hostSlots[index]].name
    return declined(step) ? `${zone} declined for capacity` : `${zone} ${stateOf(step)}`
  })
  const approved = `${hostSlots.length} approved ${hostSlots.length === 1 ? 'zone' : 'zones'}, each tried once`
  return `${attempts.join(', ') || 'none yet'} · ${approved}`
}

/**
 * The single wording for AWS health. Retained health is point-in-time evidence,
 * not a statement about the current state of the instance.
 */
export function healthDisclosure(record: Deployment): string {
  return record.health === null
    ? 'not verified'
    : `running with system, instance and attached-EBS checks ok at ${record.health.checkedAt}; point-in-time AWS status only`
}

/**
 * An open or uncertain step has an unknown effect, so nothing continues from
 * it. A returned step is not stuck: a fresh observation can verify it.
 */
function stuck(record: Deployment): boolean {
  return record.steps.some(step => {
    const state = stateOf(step)
    return state === 'open' || state === 'uncertain'
  })
}

export function verification(record: Deployment): Verification {
  if (record.termination === 'unconfirmed' || stuck(record)) {
    return 'uncertain'
  }
  const recordedPhase = phase(record)
  return (recordedPhase === 'created' ||
    recordedPhase === 'healthy' ||
    recordedPhase === 'removed' ||
    recordedPhase === 'retained' ||
    recordedPhase === 'handed-off') &&
    record.latest !== null &&
    matches(expectation(record), record.latest)
    ? 'verified'
    : 'not-verified'
}

/**
 * Outstanding means resources or unresolved effects may remain, or a child may
 * still be active. A creation call whose identity was never retained may have
 * made a resource that Qiln cannot name, so it stays outstanding unless the
 * provider definitely refused it. Retained resources are known and identified,
 * so they are reported apart from unresolved effects.
 */
export function effects(record: Deployment): Effects {
  if (record.termination === 'unconfirmed') {
    return 'outstanding'
  }
  if (unnamed(record).length > 0 || unreleased(record).length > 0) {
    return 'outstanding'
  }
  return retained(record).length > 0 ? 'retained' : 'none'
}

/**
 * Nothing was provisioned: child termination is confirmed, every recorded step
 * was definitely refused or never dispatched, and no resource identity is
 * recorded. A reused data volume is named by the approval, so an attempt that
 * reuses one is never unprovisioned.
 */
function unprovisioned(record: Deployment): boolean {
  return (
    record.termination === 'confirmed' &&
    resources(record).length === 0 &&
    record.steps.every(step => stateOf(step) === 'refused')
  )
}

/**
 * Whether a later deployment may take over the record's alias: its removal was
 * verified and nothing remains unresolved, or it never provisioned anything.
 * Resources kept by design, or already handed off, do not prevent it.
 */
export function vacated(record: Deployment): boolean {
  const recordedPhase = phase(record)
  return (
    unprovisioned(record) ||
    ((recordedPhase === 'removed' || recordedPhase === 'retained' || recordedPhase === 'handed-off') &&
      effects(record) !== 'outstanding')
  )
}

/**
 * Why nothing may continue from this record, ignoring returned steps. Null
 * means every step has a known effect or can still be verified by observation.
 */
function unresolvedReason(record: Deployment): string | null {
  if (record.termination !== 'confirmed') {
    return 'child termination is not confirmed'
  }
  return stuck(record) ? 'a recorded step is unresolved or uncertain, and Qiln never repeats it' : null
}

/**
 * Whether returned steps may be verified from fresh evidence. This is
 * accounting and never replay, so it says nothing about removal eligibility;
 * `removable` stays the strict judgement.
 */
export function canSettle(record: Deployment): boolean {
  return unresolvedReason(record) === null
}

/**
 * Whether a new removal attempt may be offered, and if not, why. Blockers are
 * confirmed termination, no step that is unresolved or uncertain, every
 * deletion response verified, and refusal budget remaining. `eligible` only
 * permits a fresh observation and approval; it does not promise that removal
 * succeeds.
 */
export function cleanup(record: Deployment): Cleanup {
  const reason = unresolvedReason(record)
  if (reason !== null) {
    return { status: 'blocked', detail: reason }
  }
  if (!record.steps.every(settled)) {
    return { status: 'blocked', detail: 'a removal response is retained but not yet verified by observation' }
  }
  if (removalPlan(record).length === 0) {
    const kept = retained(record).length
    return {
      status: 'not-needed',
      detail:
        kept === 0
          ? 'no recorded resource remains to remove'
          : `no removable resource remains; ${kept} recorded ${kept === 1 ? 'resource is' : 'resources are'} retained by design and never removed by Qiln`,
    }
  }
  const refused = refusals(record.steps)
  if (refused >= AWS_SPEC.deployment.maximumRefusals) {
    return { status: 'blocked', detail: `${refused} removal steps were refused, which spends the allowed budget` }
  }
  return {
    status: 'eligible',
    detail: `${unreleased(record).length} recorded resources are not confirmed removed`,
  }
}

export function removable(record: Deployment): boolean {
  return cleanup(record).status === 'eligible'
}

export function deploymentFacts(record: Deployment): readonly DiagnosticFact[] {
  const { approval, binding } = record
  return [
    ['Account', binding.accountId],
    ['Operator', binding.operator.arn],
    ['Operator user ID', binding.operator.userId],
    ['Name', deploymentName(record.alias)],
    ['Deployment', record.id],
    ['Connection', record.connection],
    ['Deployment region', binding.region],
    ['CIDR', approval.cidr],
    ['Administrator CIDR', approval.ingress[0].cidr],
    ['Administrator account', approval.host.plan.bootstrap.user],
    ['Administrative key', keyDisclosure(record)],
    ['SSH host key', hostKeyDisclosure(record)],
    ['Zones', approval.zones.map(zone => zone.name).join(', ')],
    ['VPC', resourceId(record, 'create-vpc') ?? 'no identity retained'],
    ['Instance', resourceId(record, 'run-instances') ?? 'no identity retained'],
    ['Launch attempts', launchDisclosure(record)],
    ['Data volume', volumeDisclosure(record)],
    ['AWS health', healthDisclosure(record)],
    [
      'Recorded resources',
      `${resources(record).length} recorded · ${unreleased(record).length} not confirmed removed · ${retained(record).length} retained by design`,
    ],
    ['Observed outcome', describe(record)],
    ['Recorded steps', String(record.steps.length)],
    ['Removal attempts', String(record.removals.length)],
    ['Refused removals', `${refusals(record.steps)} of ${AWS_SPEC.deployment.maximumRefusals} allowed`],
    ['Child termination', record.termination],
    ['Deployment recovery', 'No replay, adoption, deletion, rebinding, or automatic recovery was attempted.'],
  ]
}
