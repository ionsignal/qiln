import { resourceId, resources, stepOf } from './topology'
import type { Action } from './graph'
import type { Deployment, Implicit, Ingress, Observation, ObservedResource } from './types'

export interface Association {
  subnetId: string
  id: string
}

export interface AddressAssociation {
  id: string
  interfaceId: string
}

/**
 * One EBS mapping the instance may report. The root volume ID is null until the
 * launch verification names it; the device name and retention are always known.
 */
export interface Mapping {
  volumeId: string | null
  deviceName: string
  deleteOnTermination: boolean
}

/**
 * What the ledger says one recorded resource should currently look like.
 * `present: false` means its deletion response was retained. For the instance,
 * a null `implicit` means the verifying observation must supply it, and
 * `mappings` is the exact set of EBS mappings it may report: any other mapping
 * is never adopted and makes the instance changed. A data volume stays present
 * after termination, and `attached` says whether it should still be attached
 * to the instance.
 */
export type Expected =
  | { kind: 'vpc'; id: string; present: boolean }
  | { kind: 'subnet'; id: string; present: boolean; slot: number }
  | { kind: 'gateway'; id: string; present: boolean; attached: boolean }
  | { kind: 'route-table'; id: string; present: boolean; routed: boolean; associations: Association[] }
  | { kind: 'group'; id: string; present: boolean; ingress: Ingress[] }
  | { kind: 'key-pair'; id: string; present: boolean }
  | { kind: 'instance'; id: string; present: boolean; implicit: Implicit | null; mappings: Mapping[] }
  | { kind: 'volume'; id: string; present: boolean; role: 'root' | 'data'; attached: boolean }
  | { kind: 'interface'; id: string; present: boolean }
  | { kind: 'address'; id: string; present: boolean; association: AddressAssociation | null }

function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index)
}

export function expectation(record: Deployment): Expected[] {
  const { zones, ingress } = record.approval
  const { root, data } = record.approval.host.plan
  const returned = (action: Action, slot = 0) => stepOf(record, action, slot)?.returned != null
  const associations: Association[] = range(zones.length).flatMap(slot => {
    const id = resourceId(record, 'associate-subnet', slot)
    const subnetId = resourceId(record, 'create-subnet', slot)
    return id && subnetId && !returned('disassociate-subnet', slot) ? [{ subnetId, id }] : []
  })
  const found = record.implicit
  const implicit = found === null ? null : { rootVolumeId: found.rootVolumeId, interfaceId: found.interfaceId }
  const terminated = returned('terminate-instance')
  const dataAttached = returned('attach-volume') && !terminated
  const mappings: Mapping[] = [
    { volumeId: found?.rootVolumeId ?? null, deviceName: root.deviceName, deleteOnTermination: root.deleteOnTermination },
    ...(dataAttached
      ? [
          {
            volumeId: resourceId(record, 'create-volume'),
            deviceName: data.deviceName,
            deleteOnTermination: data.deleteOnTermination,
          },
        ]
      : []),
  ]
  const associationId = resourceId(record, 'associate-address')
  const association =
    associationId === null || found === null || returned('disassociate-address')
      ? null
      : { id: associationId, interfaceId: found.interfaceId }
  return resources(record).map(({ kind, id, slot, disposition, removal }): Expected => {
    const present = removal?.returned == null
    switch (kind) {
      case 'vpc':
        return { kind, id, present }
      case 'subnet':
        return { kind, id, present, slot }
      case 'gateway':
        return { kind, id, present, attached: returned('attach-gateway') && !returned('detach-gateway') }
      case 'route-table':
        return { kind, id, present, routed: returned('create-route'), associations }
      case 'group':
        return { kind, id, present, ingress: ingress.filter((_, index) => returned('allow-ingress', index)) }
      case 'key-pair':
        return { kind, id, present }
      case 'instance':
        return { kind, id, present, implicit, mappings }
      case 'volume': {
        const role = disposition === 'implicit' ? 'root' : 'data'
        return { kind, id, present, role, attached: role === 'root' || dataAttached }
      }
      case 'interface':
        return { kind, id, present }
      case 'address':
        return { kind, id, present, association }
    }
  })
}

/**
 * A present instance must report its root volume and interface, and once those
 * are recorded the report must name the same ones.
 */
function instanceAgrees(expected: readonly Expected[], observation: Observation): boolean {
  const instance = expected.find(item => item.kind === 'instance')
  if (instance === undefined || !instance.present) {
    return true
  }
  const seen = observation.implicit
  return (
    seen !== null &&
    (instance.implicit === null ||
      (instance.implicit.rootVolumeId === seen.rootVolumeId && instance.implicit.interfaceId === seen.interfaceId))
  )
}

/**
 * The instance is expected present, but its launch is not verified yet, so no
 * ledger entry names the root volume and primary interface that AWS created.
 */
function launching(expected: readonly Expected[]): boolean {
  const instance = expected.find(item => item.kind === 'instance')
  return instance !== undefined && instance.present && instance.implicit === null
}

/**
 * Every resource an agreeing observation must report, with its state. A
 * launching instance also reports its root volume and interface, present, so
 * the observation that verifies the launch is complete for the ledger that the
 * same write then records. Null means those two were not reported at all.
 */
function wantedStates(expected: readonly Expected[], observation: Observation): ObservedResource[] | null {
  const states = expected.map(
    (item): ObservedResource => ({ kind: item.kind, id: item.id, state: item.present ? 'present' : 'absent' }),
  )
  if (!launching(expected)) {
    return states
  }
  const { implicit } = observation
  if (implicit === null) {
    return null
  }
  return [
    ...states,
    { kind: 'volume', id: implicit.rootVolumeId, state: 'present' },
    { kind: 'interface', id: implicit.interfaceId, state: 'present' },
  ]
}

export function matches(expected: readonly Expected[], observation: Observation): boolean {
  const wanted = wantedStates(expected, observation)
  return (
    wanted !== null &&
    observation.resources.length === wanted.length &&
    wanted.every(item =>
      observation.resources.some(
        observed => observed.kind === item.kind && observed.id === item.id && observed.state === item.state,
      ),
    ) &&
    instanceAgrees(expected, observation)
  )
}
