import { AWS_SPEC } from '../../spec'
import { sameJson } from '../../../json'
import { expectation, matches } from '../observe/expect'
import { invalidDeployment } from './invalid'
import { declined, refusals, settled, stateOf } from './step'
import { creationPlan, creationsOf, creationVerified, hostKeyDue, removalPlan, resourceId } from '../topology'
import type { Deployment, Step } from '../types'

const FIXED_FIELDS = ['version', 'id', 'alias', 'previous', 'connection', 'binding', 'approval', 'createdAt'] as const

function fenceOpens(current: Deployment, updated: Deployment): boolean {
  return current.termination === 'confirmed' && updated.termination === 'unconfirmed'
}

function requireFixedFields(current: Deployment, updated: Deployment): void {
  for (const key of FIXED_FIELDS) {
    if (!sameJson(current[key], updated[key])) {
      return invalidDeployment()
    }
  }
}

/**
 * The administrative key binding is set once, before any step exists, and is
 * never rewritten, dropped, or replaced.
 */
function requireAdminKey(current: Deployment, updated: Deployment): void {
  if (current.adminKey !== null) {
    if (!sameJson(current.adminKey, updated.adminKey)) {
      return invalidDeployment()
    }
    return
  }
  if (updated.adminKey !== null && (current.steps.length !== 0 || updated.steps.length !== 0)) {
    return invalidDeployment()
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
    return invalidDeployment()
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
    return invalidDeployment()
  }
}

/**
 * A new step is open, follows the fixed plan, and starts only after the previous
 * step was verified, except that a launch attempt may follow one that was
 * declined for capacity. Creation never resumes once any removal exists, and
 * never starts without the administrative key binding. The plan position
 * counts creations without the declined attempts that a later attempt replaced.
 */
function requireNewStep(current: Deployment, updated: Deployment, step: Step): void {
  const previous = current.steps.at(-1)
  if (!fenceOpens(current, updated) || stateOf(step) !== 'open') {
    return invalidDeployment()
  }
  if (step.removal === null) {
    const planned = creationPlan(updated.approval).at(creationsOf(updated.steps).length - 1)
    if (
      updated.adminKey === null ||
      current.removals.length !== 0 ||
      updated.removals.length !== 0 ||
      planned?.action !== step.action ||
      planned.slot !== step.slot ||
      (previous !== undefined &&
        stateOf(previous) !== 'verified' &&
        !(declined(previous) && previous.action === step.action))
    ) {
      return invalidDeployment()
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
    return invalidDeployment()
  }
  if (updated.removals.length > current.removals.length) {
    requireRemovalApproval(current, updated, previous)
  } else if (previous.removal !== step.removal || stateOf(previous) !== 'verified') {
    return invalidDeployment()
  }
}

function requireSteps(current: Deployment, updated: Deployment): void {
  const before = current.steps
  const after = updated.steps
  if (after.length < before.length || after.length > before.length + 1) {
    return invalidDeployment()
  }
  const added = after.length > before.length
  before.forEach((step, index) => {
    const next = after[index]
    if (added || index < before.length - 1) {
      if (!sameJson(step, next)) {
        return invalidDeployment()
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
    return invalidDeployment()
  }
  before.forEach((removal, index) => {
    if (!sameJson(removal, after[index])) {
      return invalidDeployment()
    }
  })
  if (after.length > before.length && updated.steps.length !== current.steps.length + 1) {
    return invalidDeployment()
  }
}

function requireObservations(current: Deployment, updated: Deployment): void {
  if (current.latest !== null && (updated.latest === null || updated.latest.observedAt < current.latest.observedAt)) {
    return invalidDeployment()
  }
}

function requireImplicit(current: Deployment, updated: Deployment): void {
  if (current.implicit !== null && !sameJson(current.implicit, updated.implicit)) {
    return invalidDeployment()
  }
}

/**
 * Health is set once and never rewritten or dropped. The write that sets it
 * changes nothing else, and happens only with every creation step verified,
 * no removal, and confirmed child termination.
 */
function requireHealth(current: Deployment, updated: Deployment): void {
  if (current.health !== null) {
    if (!sameJson(current.health, updated.health)) {
      return invalidDeployment()
    }
    return
  }
  if (updated.health === null) {
    return
  }
  if (
    !creationVerified(current) ||
    current.removals.length !== 0 ||
    current.termination !== 'confirmed' ||
    updated.health.instanceId !== resourceId(current, 'run-instances') ||
    !sameJson({ ...current, health: updated.health }, updated)
  ) {
    return invalidDeployment()
  }
}

/**
 * The host-key pin is set once and never rewritten or dropped. The write that
 * sets it changes nothing else, and happens only when a pin is due: every
 * creation step verified, no removal, the administrative key bound, and
 * confirmed child termination.
 */
function requireHostKey(current: Deployment, updated: Deployment): void {
  if (current.hostKey !== null) {
    if (!sameJson(current.hostKey, updated.hostKey)) {
      return invalidDeployment()
    }
    return
  }
  if (updated.hostKey === null) {
    return
  }
  if (
    !hostKeyDue(current) ||
    current.termination !== 'confirmed' ||
    updated.hostKey.instanceId !== resourceId(current, 'run-instances') ||
    !sameJson({ ...current, hostKey: updated.hostKey }, updated)
  ) {
    return invalidDeployment()
  }
}

/**
 * A handoff is set once and never rewritten or dropped. The write that sets it
 * changes nothing else. Whether the record is settled enough to let go of its
 * volume is judged by the record audit.
 */
function requireHandoff(current: Deployment, updated: Deployment): void {
  if (current.handoff !== null) {
    if (!sameJson(current.handoff, updated.handoff)) {
      return invalidDeployment()
    }
    return
  }
  if (updated.handoff !== null && !sameJson({ ...current, handoff: updated.handoff }, updated)) {
    return invalidDeployment()
  }
}

/**
 * The journal's write rule: one record may replace another only through a
 * permitted step. Both records are already validated by their guard.
 */
export function requireTransition(current: Deployment, updated: Deployment): void {
  requireFixedFields(current, updated)
  requireAdminKey(current, updated)
  requireSteps(current, updated)
  requireRemovals(current, updated)
  requireObservations(current, updated)
  requireImplicit(current, updated)
  requireHealth(current, updated)
  requireHostKey(current, updated)
  requireHandoff(current, updated)
}
