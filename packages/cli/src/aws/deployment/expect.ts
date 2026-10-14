import type { Action } from './graph'
import { resourceId, resources, stepOf } from './topology'
import type { Deployment, Implicit, Ingress, Observation } from './types'

export interface Association {
  subnetId: string
  id: string
}

export interface AddressAssociation {
  id: string
  interfaceId: string
}

/**
 * What the ledger says one recorded resource should currently look like.
 * `present: false` means its deletion response was retained. For the instance,
 * a null `implicit` means the verifying observation must supply it. A data
 * volume stays present after termination, and `attached` says whether it
 * should still be attached to the instance.
 */
export type Expected =
  | { kind: 'vpc'; id: string; present: boolean }
  | { kind: 'subnet'; id: string; present: boolean; slot: number }
  | { kind: 'gateway'; id: string; present: boolean; attached: boolean }
  | { kind: 'route-table'; id: string; present: boolean; routed: boolean; associations: Association[] }
  | { kind: 'group'; id: string; present: boolean; ingress: Ingress[] }
  | { kind: 'key-pair'; id: string; present: boolean }
  | { kind: 'instance'; id: string; present: boolean; implicit: Implicit | null }
  | { kind: 'volume'; id: string; present: boolean; role: 'root' | 'data'; attached: boolean }
  | { kind: 'interface'; id: string; present: boolean }
  | { kind: 'address'; id: string; present: boolean; association: AddressAssociation | null }

function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index)
}

export function expectation(record: Deployment): Expected[] {
  const { zones, ingress } = record.approval
  const returned = (action: Action, slot = 0) => stepOf(record, action, slot)?.returned != null
  const associations: Association[] = range(zones.length).flatMap(slot => {
    const id = resourceId(record, 'associate-subnet', slot)
    const subnetId = resourceId(record, 'create-subnet', slot)
    return id && subnetId && !returned('disassociate-subnet', slot) ? [{ subnetId, id }] : []
  })
  const found = record.implicit
  const implicit = found === null ? null : { rootVolumeId: found.rootVolumeId, interfaceId: found.interfaceId }
  const terminated = returned('terminate-instance')
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
        return { kind, id, present, implicit }
      case 'volume': {
        const role = disposition === 'implicit' ? 'root' : 'data'
        return { kind, id, present, role, attached: role === 'root' || (returned('attach-volume') && !terminated) }
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

export function matches(expected: readonly Expected[], observation: Observation): boolean {
  return (
    observation.resources.length === expected.length &&
    expected.every(item =>
      observation.resources.some(
        observed =>
          observed.kind === item.kind && observed.id === item.id && observed.state === (item.present ? 'present' : 'absent'),
      ),
    ) &&
    instanceAgrees(expected, observation)
  )
}
