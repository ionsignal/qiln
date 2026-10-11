import type { DiagnosticFact } from '../../diagnostic/error'
import { AWS_SPEC } from '../spec'
import { verifies, type Deployment, type Fenced } from './types'

export type Phase =
  | 'approved'
  | 'not-attempted'
  | 'unresolved'
  | 'rejected'
  | 'blocked'
  | 'returned'
  | 'present'
  | 'deleted'
  | 'absent'
  | 'uncertain'

export type Effects = 'none' | 'outstanding'

const DESCRIPTIONS: Record<Phase, string> = {
  approved: 'creation approved; not attempted',
  'not-attempted': 'last mutation was not attempted; no mutating call was dispatched',
  unresolved: 'mutation fenced; outcome unresolved',
  rejected: 'last mutation was definitively rejected by the provider',
  blocked: 'removal blocked by dependencies',
  returned: 'VPC identity retained; not yet verified',
  present: 'recorded VPC freshly verified present',
  deleted: 'deletion response retained; absence unresolved',
  absent: 'recorded VPC observed absent',
  uncertain: 'outcome uncertain',
}

/** Absence clears effects only for a VPC that was seen present, since a fresh creation can be unobservable. */
function seenPresent(record: Deployment): boolean {
  return record.verified !== null || record.removals.length > 0
}

function observedAbsent(record: Deployment): boolean {
  return record.latest !== null && record.latest.vpc === null && seenPresent(record)
}

/** Present means the latest observation still shows the approved VPC, not just that one once did. */
function verifiedPresent(record: Deployment): boolean {
  return record.verified !== null && record.latest !== null && verifies(record.latest, record)
}

function attempt(item: Fenced, returned: Phase): Phase {
  const failure = item.failure
  if (failure === null) {
    return item.returned === null ? 'unresolved' : returned
  }
  return failure.outcome
}

export function phase(record: Deployment): Phase {
  const creation = record.creation
  if (creation === null) {
    return 'approved'
  }
  if (creation.returned !== null && observedAbsent(record)) {
    return 'absent'
  }
  const removal = record.removals.at(-1)
  if (removal !== undefined) {
    return attempt(removal, 'deleted')
  }
  // A later inspection may establish the VPC without rewriting an earlier failure.
  if (creation.returned !== null && verifiedPresent(record)) {
    return 'present'
  }
  return attempt(creation, 'returned')
}

export function describe(record: Deployment): string {
  return DESCRIPTIONS[phase(record)]
}

/**
 * Outstanding means resources or unresolved effects may remain, or a child may
 * still be active. Approved-but-unattempted and definitively refused creation
 * leave no effects.
 */
export function effects(record: Deployment): Effects {
  if (record.termination === 'unconfirmed') {
    return 'outstanding'
  }
  const creation = record.creation
  if (creation === null) {
    return 'none'
  }
  if (creation.returned === null) {
    const outcome = creation.failure?.outcome
    return outcome === 'not-attempted' || outcome === 'rejected' ? 'none' : 'outstanding'
  }
  return observedAbsent(record) ? 'none' : 'outstanding'
}

/**
 * Whether another removal attempt may be offered: a retained identity, confirmed
 * termination, attempts remaining, and no earlier attempt that is unresolved,
 * uncertain, or already returned. Only a definite refusal permits another.
 */
export function removable(record: Deployment): boolean {
  const prior = record.removals.at(-1)
  return (
    record.termination === 'confirmed' &&
    record.creation?.returned != null &&
    record.removals.length < AWS_SPEC.deployment.maximumRemovals &&
    (prior === undefined || (prior.failure !== null && prior.failure.outcome !== 'uncertain'))
  )
}

export function deploymentFacts(record: Deployment): readonly DiagnosticFact[] {
  return [
    ['Deployment', record.id],
    ['Connection', record.connection],
    ['Account', record.binding.accountId],
    ['Operator', record.binding.operator.arn],
    ['Operator user ID', record.binding.operator.userId],
    ['Region', record.binding.region],
    ['CIDR', record.approval.cidr],
    ['VPC', record.creation?.returned?.vpcId ?? 'no identity retained'],
    ['Observed outcome', describe(record)],
    ['Removal attempts', String(record.removals.length)],
    ['Child termination', record.termination],
    ['Deployment recovery', 'No replay, adoption, deletion, rebinding, or automatic recovery was attempted.'],
  ]
}
