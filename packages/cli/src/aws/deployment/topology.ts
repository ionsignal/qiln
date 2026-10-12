import { subnetCidr } from './cidr'
import {
  CREATION_ACTIONS,
  REMOVAL_ACTIONS,
  REMOVALS,
  RESOURCES,
  slotCount,
  type Action,
  type Kind,
  type Shape,
} from './graph'
import type { Approval, Deployment, Ingress, Observation, Placement, Step, Zone } from './types'

export interface Planned {
  action: Action
  slot: number
}

export interface Association {
  subnetId: string
  id: string
}

/**
 * What the ledger says one recorded resource should currently look like.
 * `present: false` means its deletion response was retained.
 */
export type Expected =
  | { kind: 'vpc'; id: string; present: boolean }
  | { kind: 'subnet'; id: string; present: boolean; slot: number }
  | { kind: 'gateway'; id: string; present: boolean; attached: boolean }
  | { kind: 'route-table'; id: string; present: boolean; routed: boolean; associations: Association[] }
  | { kind: 'group'; id: string; present: boolean; ingress: Ingress[] }

export interface Resource {
  kind: Kind
  id: string
  slot: number
  created: Step
  removal: Step | undefined
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index)
}

export function shapeOf(approval: Pick<Approval, 'zones' | 'ingress'>): Shape {
  return { zones: approval.zones.length, ingress: approval.ingress.length }
}

export function groupSpec(deploymentId: string): { name: string; description: string } {
  return { name: `qiln-${deploymentId}`, description: 'Qiln single-host access' }
}

export function ingressRules(administrator: string): Ingress[] {
  return [
    { port: 22, cidr: administrator },
    { port: 80, cidr: '0.0.0.0/0' },
    { port: 443, cidr: '0.0.0.0/0' },
  ]
}

/** Zones are frozen sorted by ID, so a subnet's CIDR never depends on provider list order. */
export function allocate(vpcCidr: string, zones: readonly Placement[]): Zone[] {
  return [...zones]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((zone, index) => ({ id: zone.id, name: zone.name, cidr: subnetCidr(vpcCidr, index) }))
}

/** Declaration order of the creation table is the plan order. */
export function creationPlan(approval: Pick<Approval, 'zones' | 'ingress'>): Planned[] {
  const shape = shapeOf(approval)
  return CREATION_ACTIONS.flatMap(action => range(slotCount(action, shape)).map(slot => ({ action, slot })))
}

/** The newest step for an action and slot, which is the only one that describes its current state. */
export function stepOf(record: Deployment, action: Action, slot = 0): Step | undefined {
  return record.steps.findLast(step => step.action === action && step.slot === slot)
}

export function resourceId(record: Deployment, action: Action, slot = 0): string | null {
  return stepOf(record, action, slot)?.returned?.resourceId ?? null
}

/**
 * Removal order, derived from the ledger alone: only resources whose creation
 * response was retained, and only those not yet verified removed. Declaration
 * order of the removal table is the plan order.
 */
export function removalPlan(record: Deployment): Planned[] {
  const shape = shapeOf(record.approval)
  return REMOVAL_ACTIONS.flatMap(action => {
    const created = REMOVALS[action].undoes
    return range(slotCount(action, shape))
      .filter(slot => stepOf(record, created, slot)?.returned != null && stepOf(record, action, slot)?.verifiedAt == null)
      .map(slot => ({ action, slot }))
  })
}

/** Whether an action creates a resource that owns an identity. */
export function creates(action: Action): boolean {
  return RESOURCES.some(item => item.create === action)
}

export function resources(record: Deployment): Resource[] {
  const shape = shapeOf(record.approval)
  return RESOURCES.flatMap(({ kind, create, remove }) =>
    range(slotCount(create, shape)).flatMap((slot): Resource[] => {
      const created = stepOf(record, create, slot)
      const id = created?.returned?.resourceId
      return created === undefined || !id ? [] : [{ kind, id, slot, created, removal: stepOf(record, remove, slot) }]
    }),
  )
}

/**
 * Removal is confirmed by a verified deletion step, or by absence observed
 * after the resource was seen present. Absence alone never proves who deleted it.
 */
function released(record: Deployment, { kind, id, created, removal }: Resource): boolean {
  if (removal?.verifiedAt != null) {
    return true
  }
  return (
    created.verifiedAt !== null &&
    (record.latest?.resources.some(item => item.kind === kind && item.id === id && item.state === 'absent') ?? false)
  )
}

export function unreleased(record: Deployment): Resource[] {
  return resources(record).filter(resource => !released(record, resource))
}

export function expectation(record: Deployment): Expected[] {
  const { zones, ingress } = record.approval
  const returned = (action: Action, slot = 0) => stepOf(record, action, slot)?.returned != null
  const associations: Association[] = range(zones.length).flatMap(slot => {
    const id = resourceId(record, 'associate-subnet', slot)
    const subnetId = resourceId(record, 'create-subnet', slot)
    return id && subnetId && !returned('disassociate-subnet', slot) ? [{ subnetId, id }] : []
  })
  return resources(record).map(({ kind, id, slot, removal }): Expected => {
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
    }
  })
}

export function matches(expected: readonly Expected[], observation: Observation): boolean {
  return (
    observation.resources.length === expected.length &&
    expected.every(item =>
      observation.resources.some(
        observed =>
          observed.kind === item.kind && observed.id === item.id && observed.state === (item.present ? 'present' : 'absent'),
      ),
    )
  )
}
