import { subnetCidr } from './cidr'
import {
  CREATION_ACTIONS,
  IMPLICIT,
  REMOVAL_ACTIONS,
  REMOVALS,
  RESOURCES,
  slotCount,
  type Action,
  type Disposition,
  type Kind,
  type Shape,
} from './graph'
import { stateOf } from './step'
import type { Approval, Deployment, Ingress, Placement, Step, Zone } from './types'

export interface Planned {
  action: Action
  slot: number
}

export interface Resource {
  kind: Kind
  id: string
  slot: number
  disposition: Disposition
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

export function allocate(vpcCidr: string, zones: readonly Placement[]): Zone[] {
  return [...zones]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((zone, index) => ({ id: zone.id, name: zone.name, cidr: subnetCidr(vpcCidr, index) }))
}

export function creationPlan(approval: Pick<Approval, 'zones' | 'ingress'>): Planned[] {
  const shape = shapeOf(approval)
  return CREATION_ACTIONS.flatMap(action => range(slotCount(action, shape)).map(slot => ({ action, slot })))
}

export function stepOf(record: Deployment, action: Action, slot = 0): Step | undefined {
  return record.steps.findLast(step => step.action === action && step.slot === slot)
}

export function resourceId(record: Deployment, action: Action, slot = 0): string | null {
  return stepOf(record, action, slot)?.returned?.resourceId ?? null
}

/**
 * Every planned creation step exists and is verified. Creation steps precede
 * removal steps and run in plan order, so the count alone identifies the plan.
 */
export function creationVerified(record: Deployment): boolean {
  const creations = record.steps.filter(step => step.removal === null)
  return creations.length === creationPlan(record.approval).length && creations.every(step => stateOf(step) === 'verified')
}

/**
 * Creation is complete, nothing has been removed, and no AWS health evidence
 * is retained yet.
 */
export function healthDue(record: Deployment): boolean {
  return creationVerified(record) && record.removals.length === 0 && record.health === null
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

export function creates(action: Action): boolean {
  return RESOURCES.some(item => item.create === action)
}

/**
 * Creation calls that may have made a resource whose identity was never
 * retained, because the call is still open or its outcome is uncertain.
 */
export function unnamed(record: Deployment): Step[] {
  return record.steps.filter(step => {
    const state = stateOf(step)
    return creates(step.action) && (state === 'open' || state === 'uncertain')
  })
}

/**
 * Every resource with a retained identity. The root volume and primary
 * interface join once the launch verification has observed them; they belong
 * to the instance's creation and removal steps.
 */
export function resources(record: Deployment): Resource[] {
  const shape = shapeOf(record.approval)
  const explicit = RESOURCES.flatMap(({ kind, create, remove }) =>
    range(slotCount(create, shape)).flatMap((slot): Resource[] => {
      const created = stepOf(record, create, slot)
      const id = created?.returned?.resourceId
      if (created === undefined || !id) {
        return []
      }
      return [
        {
          kind,
          id,
          slot,
          disposition: remove === null ? 'retained' : 'removed',
          created,
          removal: remove === null ? undefined : stepOf(record, remove, slot),
        },
      ]
    }),
  )
  const host = stepOf(record, IMPLICIT.parent)
  const { implicit } = record
  if (host === undefined || implicit === null) {
    return explicit
  }
  const implicitResources = IMPLICIT.kinds.map(
    (kind): Resource => ({
      kind,
      id: kind === 'volume' ? implicit.rootVolumeId : implicit.interfaceId,
      slot: 0,
      disposition: 'implicit',
      created: host,
      removal: stepOf(record, IMPLICIT.removal),
    }),
  )
  return [...explicit, ...implicitResources]
}

/**
 * Removal is confirmed by a verified deletion step, or by absence observed
 * after the resource was seen present. Absence alone never proves who deleted it.
 */
export function released(record: Deployment, { kind, id, created, removal }: Resource): boolean {
  if (removal?.verifiedAt != null) {
    return true
  }
  return (
    created.verifiedAt !== null &&
    (record.latest?.resources.some(item => item.kind === kind && item.id === id && item.state === 'absent') ?? false)
  )
}

export function unreleased(record: Deployment): Resource[] {
  return resources(record).filter(resource => resource.disposition !== 'retained' && !released(record, resource))
}

export function retained(record: Deployment): Resource[] {
  return resources(record).filter(resource => resource.disposition === 'retained' && !released(record, resource))
}
