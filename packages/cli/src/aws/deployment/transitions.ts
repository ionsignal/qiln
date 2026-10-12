import { InstallerError } from '../../diagnostic/error'
import { sameJson } from '../json'
import { AWS_SPEC } from '../spec'
import { refusals, settled, stateOf } from './step'
import { creationPlan, expectation, matches, removalPlan } from './topology'
import type { Deployment, Step } from './types'

const FIXED_FIELDS = ['version', 'id', 'connection', 'binding', 'approval', 'createdAt'] as const

function invalid(): never {
  throw new InstallerError({
    code: 'AWS_DEPLOYMENT_STATE_INVALID',
  })
}

function fenceOpens(current: Deployment, updated: Deployment): boolean {
  return current.termination === 'confirmed' && updated.termination === 'unconfirmed'
}

function requireFixedFields(current: Deployment, updated: Deployment): void {
  for (const key of FIXED_FIELDS) {
    if (!sameJson(current[key], updated[key])) {
      return invalid()
    }
  }
}

/**
 * Evidence is set once. A response cannot be added after a recorded failure
 * (the record guard already forbids both), and a failure never rewrites a response.
 */
function requireProgress(before: Step, after: Step, updated: Deployment): void {
  if (
    before.id !== after.id ||
    before.action !== after.action ||
    before.slot !== after.slot ||
    before.removal !== after.removal ||
    before.fencedAt !== after.fencedAt ||
    (before.returned !== null && !sameJson(before.returned, after.returned)) ||
    (before.failure !== null && !sameJson(before.failure, after.failure)) ||
    (before.verifiedAt !== null && before.verifiedAt !== after.verifiedAt) ||
    (before.failure === null && after.failure !== null && after.failure.termination !== updated.termination)
  ) {
    return invalid()
  }
}

/**
 * Another attempt needs a settled previous step, an unspent refusal budget, a
 * fresh approved observation that is also the latest one and still agrees with
 * the ledger, and, after a failure, an observation strictly newer than it.
 */
function requireRemovalApproval(current: Deployment, updated: Deployment, previous: Step): void {
  const approval = updated.removals.at(-1)
  if (
    approval === undefined ||
    !settled(previous) ||
    refusals(current.steps) >= AWS_SPEC.deployment.maximumRefusals ||
    !sameJson(approval.observation, updated.latest) ||
    !matches(expectation(current), approval.observation) ||
    (previous.failure !== null && approval.observation.observedAt <= previous.failure.recordedAt)
  ) {
    return invalid()
  }
}

/**
 * A new step is open, follows the fixed plan, and starts only after the previous
 * step was verified. Creation never resumes once any removal exists.
 */
function requireNewStep(current: Deployment, updated: Deployment, step: Step): void {
  const previous = current.steps.at(-1)
  if (!fenceOpens(current, updated) || stateOf(step) !== 'open') {
    return invalid()
  }
  if (step.removal === null) {
    const planned = creationPlan(updated.approval).at(current.steps.length)
    if (
      current.removals.length !== 0 ||
      updated.removals.length !== 0 ||
      planned?.action !== step.action ||
      planned.slot !== step.slot ||
      (previous !== undefined && stateOf(previous) !== 'verified')
    ) {
      return invalid()
    }
    return
  }
  const planned = removalPlan(current).at(0)
  if (
    previous === undefined ||
    step.removal !== updated.removals.length - 1 ||
    planned?.action !== step.action ||
    planned.slot !== step.slot
  ) {
    return invalid()
  }
  if (updated.removals.length > current.removals.length) {
    requireRemovalApproval(current, updated, previous)
  } else if (previous.removal !== step.removal || stateOf(previous) !== 'verified') {
    return invalid()
  }
}

function requireSteps(current: Deployment, updated: Deployment): void {
  const before = current.steps
  const after = updated.steps
  if (after.length < before.length || after.length > before.length + 1) {
    return invalid()
  }
  const added = after.length > before.length
  before.forEach((step, index) => {
    const next = after[index]
    if (added || index < before.length - 1) {
      if (!sameJson(step, next)) {
        return invalid()
      }
      return
    }
    requireProgress(step, next, updated)
  })
  if (added) {
    requireNewStep(current, updated, after[before.length])
  }
}

function requireRemovals(current: Deployment, updated: Deployment): void {
  const before = current.removals
  const after = updated.removals
  if (after.length < before.length || after.length > before.length + 1) {
    return invalid()
  }
  before.forEach((removal, index) => {
    if (!sameJson(removal, after[index])) {
      return invalid()
    }
  })
  if (after.length > before.length && updated.steps.length !== current.steps.length + 1) {
    return invalid()
  }
}

function requireObservations(current: Deployment, updated: Deployment): void {
  if (current.latest !== null && (updated.latest === null || updated.latest.observedAt < current.latest.observedAt)) {
    return invalid()
  }
}

/**
 * The journal's write rule: one record may replace another only through a
 * permitted step. Both records are already validated by their guard.
 */
export function requireTransition(current: Deployment, updated: Deployment): void {
  requireFixedFields(current, updated)
  requireSteps(current, updated)
  requireRemovals(current, updated)
  requireObservations(current, updated)
}
