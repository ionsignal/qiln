import { expectation, matches } from './expect'
import { effects, keyDisclosure } from './facts'
import type { Disposition, Kind } from './graph'
import { released, resources, type Resource } from './topology'
import type { Deployment } from './types'

/**
 * - done: removed and observed absent, absent without being established as removed by Qiln, or handed off to a later deployment.
 * - retained: present by design, identified, and not removed by Qiln.
 * - pending: not confirmed.
 * - none: nothing recorded for this row.
 */
export type OutcomeState = 'done' | 'retained' | 'pending' | 'none'

export interface Outcome {
  label: string
  state: OutcomeState
  detail: string
}

const NETWORK: readonly Kind[] = ['vpc', 'subnet', 'gateway', 'route-table', 'group']

function find(record: Deployment, kind: Kind, disposition: Disposition = 'removed'): Resource | undefined {
  return resources(record).find(item => item.kind === kind && item.disposition === disposition)
}

function removal(record: Deployment, label: string, resource: Resource | undefined, done: string): Outcome {
  if (resource === undefined) {
    return { label, state: 'none', detail: 'no identity recorded' }
  }
  if (!released(record, resource)) {
    return { label, state: 'pending', detail: `${resource.id} not confirmed removed` }
  }
  const byQiln = resource.removal?.verifiedAt != null
  return {
    label,
    state: 'done',
    detail: `${resource.id} ${byQiln ? done : 'observed absent; not established as removed by Qiln'}`,
  }
}

/**
 * A retained volume is reported as retained only once the host is gone and a
 * matching observation found it present and unattached. It is never reported
 * as absent, and it keeps incurring charges until it is deleted outside Qiln.
 * A volume handed off to a later deployment is that deployment's to report.
 */
function dataVolume(record: Deployment): Outcome {
  const label = 'Data volume'
  const volume = find(record, 'volume', 'retained') ?? find(record, 'volume', 'handed-off')
  if (volume === undefined) {
    return { label, state: 'none', detail: 'no identity recorded' }
  }
  if (record.handoff !== null) {
    return {
      label,
      state: 'done',
      detail: `${volume.id} handed off to deployment ${record.handoff.to}; no longer observed by this record`,
    }
  }
  if (released(record, volume)) {
    return { label, state: 'done', detail: `${volume.id} observed absent; Qiln holds no authority to delete it` }
  }
  const instance = find(record, 'instance')
  const unattached =
    instance !== undefined &&
    released(record, instance) &&
    record.latest !== null &&
    matches(expectation(record), record.latest)
  return unattached
    ? {
        label,
        state: 'retained',
        detail: `${volume.id} retained by design and observed present and unattached. Qiln cannot delete it, and it keeps incurring charges until it is deleted outside Qiln.`,
      }
    : { label, state: 'pending', detail: `${volume.id} retained by design; not yet observed unattached after termination` }
}

function network(record: Deployment): Outcome {
  const label = 'Network'
  const recorded = resources(record).filter(item => NETWORK.includes(item.kind))
  if (recorded.length === 0) {
    return { label, state: 'none', detail: 'no identity recorded' }
  }
  const remaining = recorded.filter(item => !released(record, item))
  return remaining.length === 0
    ? { label, state: 'done', detail: `${recorded.length} recorded resources removed or observed absent` }
    : { label, state: 'pending', detail: `${remaining.length} of ${recorded.length} recorded resources not confirmed removed` }
}

/**
 * Removal never reads or deletes the local administrative key files, so only
 * the recorded binding is reported. Their availability was not checked.
 */
function localKey(record: Deployment): Outcome {
  const label = 'Local admin key'
  if (record.adminKey === null) {
    return { label, state: 'none', detail: keyDisclosure(record) }
  }
  return {
    label,
    state: 'retained',
    detail: `${keyDisclosure(record)}. Qiln never deletes the local key files.`,
  }
}

function unresolved(record: Deployment): Outcome {
  const label = 'Unresolved effects'
  return effects(record) === 'outstanding'
    ? { label, state: 'pending', detail: 'resources or outcomes remain unresolved; see the recorded steps' }
    : { label, state: 'none', detail: 'none recorded' }
}

export function removalOutcome(record: Deployment): Outcome[] {
  return [
    removal(record, 'Instance', find(record, 'instance'), 'terminated and observed absent'),
    removal(record, 'Root volume', find(record, 'volume', 'implicit'), 'deleted with the instance and observed absent'),
    removal(record, 'Primary interface', find(record, 'interface', 'implicit'), 'deleted with the instance and observed absent'),
    dataVolume(record),
    removal(record, 'Elastic IP', find(record, 'address'), 'allocation released and observed absent'),
    removal(
      record,
      'AWS key pair',
      find(record, 'key-pair'),
      'deleted and observed absent; this is not guest SSH revocation, and guest authorized keys are unaffected',
    ),
    localKey(record),
    network(record),
    unresolved(record),
  ]
}
