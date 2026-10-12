import type { DiagnosticFact } from '../../diagnostic/error'
import { AWS_SPEC } from '../spec'
import { refusals, settled, stateOf } from './step'
import { creates, creationPlan, removalPlan, resourceId, resources, unreleased } from './topology'
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
 * Whether a new removal attempt may be offered: confirmed termination, a
 * non-empty plan, refusal budget remaining, and no step that is unresolved or
 * uncertain. Only definite refusals and retained identities permit another.
 */
export function removable(record: Deployment): boolean {
  return (
    record.termination === 'confirmed' &&
    refusals(record.steps) < AWS_SPEC.deployment.maximumRefusals &&
    record.steps.every(settled) &&
    removalPlan(record).length > 0
  )
}

export function deploymentFacts(record: Deployment): readonly DiagnosticFact[] {
  const { approval, binding } = record
  return [
    ['Deployment', record.id],
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
