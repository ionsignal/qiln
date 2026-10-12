import type { DiagnosticFact } from '../../diagnostic/error'
import { AWS_SPEC } from '../spec'
import { deploymentName } from './alias'
import { refusals, settled, stateOf } from './step'
import { creates, creationPlan, expectation, matches, removalPlan, resourceId, resources, unreleased } from './topology'
import type { Deployment } from './types'

export type Phase =
  | 'approved'
  | 'not-attempted'
  | 'unresolved'
  | 'rejected'
  | 'blocked'
  | 'returned'
  | 'uncertain'
  | 'partial'
  | 'created'
  | 'removing'
  | 'removed'
  | 'absent'

export type Effects = 'none' | 'outstanding'
export type Verification = 'verified' | 'not-verified' | 'uncertain'

export interface Cleanup {
  status: 'not-needed' | 'eligible' | 'blocked'
  detail: string
}

const DESCRIPTIONS: Record<Phase, string> = {
  approved: 'creation approved; not attempted',
  'not-attempted': 'last mutation was not attempted; no mutating call was dispatched',
  unresolved: 'mutation fenced; outcome unresolved',
  rejected: 'last mutation was definitively rejected by the provider',
  blocked: 'removal blocked by dependencies',
  returned: 'response retained; not yet verified by observation',
  uncertain: 'outcome uncertain',
  partial: 'creation stopped after a verified step; network incomplete',
  created: 'network created and observed',
  removing: 'removal partly verified; recorded resources remain',
  removed: 'all recorded resources removed and observed absent',
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
    return record.removals.length > 0 ? 'removed' : 'absent'
  }
  if (last.removal !== null) {
    return 'removing'
  }
  return record.steps.length === creationPlan(record.approval).length ? 'created' : 'partial'
}

export function describe(record: Deployment): string {
  return DESCRIPTIONS[phase(record)]
}

export function verification(record: Deployment): Verification {
  if (
    record.termination === 'unconfirmed' ||
    record.steps.some(step => {
      const state = stateOf(step)
      return state === 'open' || state === 'uncertain'
    })
  ) {
    return 'uncertain'
  }
  const recordedPhase = phase(record)
  return (recordedPhase === 'created' || recordedPhase === 'removed') &&
    record.latest !== null &&
    matches(expectation(record), record.latest)
    ? 'verified'
    : 'not-verified'
}

/**
 * Outstanding means resources or unresolved effects may remain, or a child may
 * still be active. A creation call whose identity was never retained may have
 * made a resource that Qiln cannot name, so it stays outstanding unless the
 * provider definitely refused it.
 */
export function effects(record: Deployment): Effects {
  if (record.termination === 'unconfirmed') {
    return 'outstanding'
  }
  const unnamed = record.steps.some(step => {
    const state = stateOf(step)
    return creates(step.action) && (state === 'open' || state === 'uncertain')
  })
  return unnamed || unreleased(record).length > 0 ? 'outstanding' : 'none'
}

/**
 * Whether a new removal attempt may be offered, and if not, why. Blockers are
 * confirmed termination, no step that is unresolved or uncertain, and refusal
 * budget remaining. `eligible` only permits a fresh observation and approval;
 * it does not promise that removal succeeds.
 */
export function cleanup(record: Deployment): Cleanup {
  if (record.termination !== 'confirmed') {
    return { status: 'blocked', detail: 'child termination is not confirmed' }
  }
  if (!record.steps.every(settled)) {
    return { status: 'blocked', detail: 'a recorded step is unresolved or uncertain, and Qiln never repeats it' }
  }
  if (removalPlan(record).length === 0) {
    return { status: 'not-needed', detail: 'no recorded resource remains to remove' }
  }
  const refused = refusals(record.steps)
  if (refused >= AWS_SPEC.deployment.maximumRefusals) {
    return { status: 'blocked', detail: `${refused} removal steps were refused, which spends the allowed budget` }
  }
  return {
    status: 'eligible',
    detail: `${unreleased(record).length} recorded resources are not confirmed removed; removal needs a fresh observation and approval`,
  }
}

export function removable(record: Deployment): boolean {
  return cleanup(record).status === 'eligible'
}

export function deploymentFacts(record: Deployment): readonly DiagnosticFact[] {
  const { approval, binding } = record
  return [
    ['Deployment', record.id],
    ['Name', deploymentName(record.alias)],
    ['Connection', record.connection],
    ['Account', binding.accountId],
    ['Operator', binding.operator.arn],
    ['Operator user ID', binding.operator.userId],
    ['Region', binding.region],
    ['CIDR', approval.cidr],
    ['Zones', approval.zones.map(zone => zone.name).join(', ')],
    ['Administrator CIDR', approval.ingress[0].cidr],
    ['VPC', resourceId(record, 'create-vpc') ?? 'no identity retained'],
    [
      'Recorded resources',
      `${resources(record).length} retained · ${unreleased(record).length} not confirmed removed`,
    ],
    ['Observed outcome', describe(record)],
    ['Recorded steps', String(record.steps.length)],
    ['Removal attempts', String(record.removals.length)],
    ['Refused removals', `${refusals(record.steps)} of ${AWS_SPEC.deployment.maximumRefusals} allowed`],
    ['Child termination', record.termination],
    ['Deployment recovery', 'No replay, adoption, deletion, rebinding, or automatic recovery was attempted.'],
  ]
}
