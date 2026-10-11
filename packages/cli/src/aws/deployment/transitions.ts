import { InstallerError } from '../../diagnostic/error'
import { sameJson } from '../json'
import type { Deployment, Fenced, Removal } from './types'

const FIXED_FIELDS = ['version', 'id', 'connection', 'binding', 'approval', 'createdAt'] as const

function invalid(): never {
  throw new InstallerError({
    code: 'AWS_DEPLOYMENT_STATE_INVALID',
  })
}

/** A new fence may open only while no child can be active, and must record that one now is. */
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
 * Evidence is set once. A response cannot be added after a recorded failure,
 * and a failure never rewrites a response.
 */
function requireProgress(before: Fenced, after: Fenced, updated: Deployment): void {
  if (
    before.id !== after.id ||
    before.fencedAt !== after.fencedAt ||
    (before.returned !== null && !sameJson(before.returned, after.returned)) ||
    (before.failure !== null && !sameJson(before.failure, after.failure)) ||
    (before.returned === null && after.returned !== null && before.failure !== null) ||
    (before.failure === null && after.failure !== null && after.failure.termination !== updated.termination)
  ) {
    return invalid()
  }
}

function requireCreation(current: Deployment, updated: Deployment): void {
  const before = current.creation
  const after = updated.creation
  if (before !== null) {
    if (after === null) {
      return invalid()
    }
    requireProgress(before, after, updated)
    return
  }
  if (after !== null && (!fenceOpens(current, updated) || after.returned !== null || after.failure !== null)) {
    return invalid()
  }
}

/**
 * Another attempt needs the retained identity, a fresh approved observation
 * that is also the latest one, and a prior definite refusal. An uncertain or
 * unresolved attempt never authorizes another.
 */
function requireNewRemoval(current: Deployment, updated: Deployment, removal: Removal): void {
  const vpcId = current.creation?.returned?.vpcId
  const observation = removal.approval.observation
  if (
    vpcId === undefined ||
    !fenceOpens(current, updated) ||
    removal.returned !== null ||
    removal.failure !== null ||
    observation.vpcId !== vpcId ||
    !sameJson(observation, updated.latest)
  ) {
    return invalid()
  }
  const prior = current.removals.at(-1)
  if (prior !== undefined) {
    const refusal = prior.failure
    if (refusal === null || refusal.outcome === 'uncertain' || observation.observedAt <= refusal.recordedAt) {
      return invalid()
    }
  }
}

function requireRemovals(current: Deployment, updated: Deployment): void {
  const before = current.removals
  const after = updated.removals
  if (after.length < before.length || after.length > before.length + 1) {
    return invalid()
  }
  before.forEach((prior, index) => {
    const next = after[index]
    if (!sameJson(prior.approval, next.approval)) {
      return invalid()
    }
    requireProgress(prior, next, updated)
  })
  const added = after[before.length]
  if (added !== undefined) {
    requireNewRemoval(current, updated, added)
  }
}

/** Observations only move forward, and a verified one is kept exactly as first saved with the latest. */
function requireObservations(current: Deployment, updated: Deployment): void {
  if (current.latest !== null && (updated.latest === null || updated.latest.observedAt < current.latest.observedAt)) {
    return invalid()
  }
  if (current.verified !== null) {
    if (!sameJson(current.verified, updated.verified)) {
      return invalid()
    }
    return
  }
  if (updated.verified !== null && !sameJson(updated.verified, updated.latest)) {
    return invalid()
  }
}

/**
 * The journal's write rule: one record may replace another only through a
 * permitted step. Both records are already validated by their guard.
 */
export function requireTransition(current: Deployment, updated: Deployment): void {
  requireFixedFields(current, updated)
  requireCreation(current, updated)
  requireRemovals(current, updated)
  requireObservations(current, updated)
}
