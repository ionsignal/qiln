import { IMPLICIT, undoes } from '../graph'
import { declined, settled, stateOf } from './step'
import {
  creationPlan,
  creationsOf,
  creationVerified,
  dataVolumeId,
  launches,
  resourceId,
  resources,
  stepOf,
  unnamed,
  unreleased,
} from '../topology'
import type { Deployment, ObservedResource, Step } from '../types'

/**
 * Cross-field consistency of a record whose shape is already valid. These are
 * the rules the coordinator follows when it writes, restated so that a record
 * that was edited, truncated, or written by another version fails closed.
 */

function uniqueIds(record: Deployment): boolean {
  return new Set(record.steps.map(step => step.id)).size === record.steps.length
}

function inPlan(record: Deployment): boolean {
  const plan = creationPlan(record.approval)
  const creationSteps = record.steps.filter(step => step.removal === null)
  const deletions = record.steps.slice(creationSteps.length)
  const creations = creationsOf(creationSteps)
  let attempt = -1
  for (const { removal } of deletions) {
    if (removal === null || (removal !== attempt && removal !== attempt + 1)) {
      return false
    }
    attempt = removal
  }
  return (
    creations.length <= plan.length &&
    creations.every((step, index) => step.action === plan[index].action && step.slot === plan[index].slot) &&
    attempt === record.removals.length - 1
  )
}

/**
 * Only approved zones are attempted, and every launch attempt but the newest
 * was definitely declined for capacity.
 */
function launchesOrdered(record: Deployment): boolean {
  const attempts = launches(record)
  return attempts.length <= record.approval.host.plan.hostSlots.length && attempts.slice(0, -1).every(declined)
}

/**
 * Creation continues only from a verified step, except that a launch attempt
 * may follow one that was declined for capacity. A removal attempt continues
 * from a verified step, and a new attempt starts from any settled one.
 */
function ordered(steps: readonly Step[]): boolean {
  return steps.slice(1).every((step, index) => {
    const previous = steps[index]
    if (step.removal === null || step.removal === previous.removal) {
      return stateOf(previous) === 'verified' || (declined(previous) && step.action === previous.action)
    }
    return settled(previous)
  })
}

function timed(record: Deployment): boolean {
  const { steps, latest } = record
  return steps.every((step, index) => {
    const { fencedAt, returned, failure, verifiedAt } = step
    return (
      (index === 0 || steps[index - 1].fencedAt <= fencedAt) &&
      (returned === null || returned.returnedAt >= fencedAt) &&
      (failure === null || failure.recordedAt >= fencedAt) &&
      (verifiedAt === null ||
        (returned !== null && verifiedAt >= returned.returnedAt && latest !== null && latest.observedAt >= verifiedAt))
    )
  })
}

/**
 * No step exists without the administrative key binding, and the key is
 * generated after approval and before the first step.
 */
function keyed(record: Deployment): boolean {
  const { adminKey, steps, approval } = record
  if (adminKey === null) {
    return steps.length === 0
  }
  return (
    adminKey.algorithm === approval.host.plan.key.algorithm &&
    approval.approvedAt <= adminKey.generatedAt &&
    (steps.length === 0 || adminKey.generatedAt <= steps[0].fencedAt)
  )
}

function identified(record: Deployment): boolean {
  const { implicit } = record
  const { volume } = record.approval.host
  const ids = [
    ...record.steps.flatMap(step => step.returned?.resourceId ?? []),
    ...(implicit === null ? [] : [implicit.rootVolumeId, implicit.interfaceId]),
    ...(volume.kind === 'reuse' ? [volume.volumeId] : []),
  ]
  return new Set(ids).size === ids.length
}

function undone(record: Deployment): boolean {
  return record.steps.every(step => {
    const created = undoes(step.action)
    return created === null || stepOf(record, created, step.slot)?.returned != null
  })
}

function discovered(record: Deployment): boolean {
  return (stepOf(record, IMPLICIT.parent)?.verifiedAt != null) === (record.implicit !== null)
}

/**
 * Health evidence exists only for a fully created deployment, names the
 * launched instance, is no older than the launch verification, and precedes
 * every removal.
 */
function healthRecorded(record: Deployment): boolean {
  const { health, implicit, steps } = record
  if (health === null) {
    return true
  }
  const launch = stepOf(record, IMPLICIT.parent)
  if (launch === undefined || launch.verifiedAt === null || implicit === null) {
    return false
  }
  return (
    creationVerified(record) &&
    health.instanceId === launch.returned?.resourceId &&
    health.checkedAt >= launch.verifiedAt &&
    steps.every(step => step.removal === null || step.fencedAt >= health.checkedAt)
  )
}

/**
 * The host-key pin exists only for a fully created deployment, names the
 * launched instance and the allocated address, is no older than the launch
 * verification, and precedes every removal.
 */
function hostKeyRecorded(record: Deployment): boolean {
  const { hostKey, steps } = record
  if (hostKey === null) {
    return true
  }
  const launch = stepOf(record, IMPLICIT.parent)
  if (launch === undefined || launch.verifiedAt === null) {
    return false
  }
  return (
    creationVerified(record) &&
    hostKey.instanceId === launch.returned?.resourceId &&
    hostKey.allocationId === resourceId(record, 'allocate-address') &&
    hostKey.observedAt >= launch.verifiedAt &&
    steps.every(step => step.removal === null || step.fencedAt >= hostKey.observedAt)
  )
}

/**
 * A handoff lets go of the identified data volume to another deployment, so
 * nothing else of this record may still be outstanding.
 */
function handedOff(record: Deployment): boolean {
  const { handoff } = record
  return (
    handoff === null ||
    (handoff.to !== record.id &&
      dataVolumeId(record) !== null &&
      record.termination === 'confirmed' &&
      unnamed(record).length === 0 &&
      unreleased(record).length === 0)
  )
}

/**
 * Every observed resource is recorded, except that before the launch is
 * verified the observation also carries the instance's root volume and
 * interface, which are the two named by its own `implicit` relationship.
 */
function observedKnown(record: Deployment): boolean {
  const { latest, implicit } = record
  if (latest === null) {
    return true
  }
  const known = resources(record)
  const launching = implicit === null ? latest.implicit : null
  const isKnown = (item: ObservedResource) =>
    known.some(resource => resource.kind === item.kind && resource.id === item.id) ||
    (launching !== null &&
      ((item.kind === 'volume' && item.id === launching.rootVolumeId) ||
        (item.kind === 'interface' && item.id === launching.interfaceId)))
  return (
    latest.resources.every(isKnown) &&
    (implicit === null ||
      latest.implicit === null ||
      (implicit.rootVolumeId === latest.implicit.rootVolumeId && implicit.interfaceId === latest.implicit.interfaceId))
  )
}

export function isConsistent(record: Deployment): boolean {
  return (
    uniqueIds(record) &&
    inPlan(record) &&
    launchesOrdered(record) &&
    ordered(record.steps) &&
    timed(record) &&
    keyed(record) &&
    identified(record) &&
    undone(record) &&
    discovered(record) &&
    healthRecorded(record) &&
    hostKeyRecorded(record) &&
    handedOff(record) &&
    observedKnown(record)
  )
}
