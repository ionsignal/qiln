/**
 * The one authored description of the deployment graph: which actions exist, in
 * what order they run, what identity each returns, and how many slots each
 * uses. Plans, resource tracking, receipts, and observation bounds derive
 * from it. It stays pure and SDK-free so `ec2/` keeps all provider code.
 */
export const KIND_IDS = {
  'vpc': /^vpc-[0-9a-f]{8,17}$/,
  'subnet': /^subnet-[0-9a-f]{8,17}$/,
  'gateway': /^igw-[0-9a-f]{8,17}$/,
  'route-table': /^rtb-[0-9a-f]{8,17}$/,
  'group': /^sg-[0-9a-f]{8,17}$/,
  'key-pair': /^key-[0-9a-f]{8,17}$/,
  'instance': /^i-[0-9a-f]{8,17}$/,
  'volume': /^vol-[0-9a-f]{8,17}$/,
  'interface': /^eni-[0-9a-f]{8,17}$/,
  'address': /^eipalloc-[0-9a-f]{8,17}$/,
} as const

export type Kind = keyof typeof KIND_IDS

type Slots = 'one' | 'zone' | 'ingress'

export interface Shape {
  zones: number
  ingress: number
}

interface CreationEntry {
  slots: Slots
  resource: Kind | null
  receipt: RegExp | null
}

/**
 * Declaration order is creation plan order. `create-route`, `allow-ingress`,
 * and `attach-volume` have no removal: they die with their parent resource.
 * The instance precedes the data volume so a capacity refusal never leaves a
 * volume that Qiln has no authority to delete.
 */
export const CREATIONS = {
  'create-vpc': { slots: 'one', resource: 'vpc', receipt: KIND_IDS.vpc },
  'create-subnet': { slots: 'zone', resource: 'subnet', receipt: KIND_IDS.subnet },
  'create-gateway': { slots: 'one', resource: 'gateway', receipt: KIND_IDS.gateway },
  'attach-gateway': { slots: 'one', resource: null, receipt: null },
  'create-route-table': { slots: 'one', resource: 'route-table', receipt: KIND_IDS['route-table'] },
  'create-route': { slots: 'one', resource: null, receipt: null },
  'associate-subnet': { slots: 'zone', resource: null, receipt: /^rtbassoc-[0-9a-f]{8,17}$/ },
  'create-group': { slots: 'one', resource: 'group', receipt: KIND_IDS.group },
  'allow-ingress': { slots: 'ingress', resource: null, receipt: /^sgr-[0-9a-f]{8,17}$/ },
  'import-key-pair': { slots: 'one', resource: 'key-pair', receipt: KIND_IDS['key-pair'] },
  'run-instances': { slots: 'one', resource: 'instance', receipt: KIND_IDS.instance },
  'create-volume': { slots: 'one', resource: 'volume', receipt: KIND_IDS.volume },
  'attach-volume': { slots: 'one', resource: null, receipt: null },
  'allocate-address': { slots: 'one', resource: 'address', receipt: KIND_IDS.address },
  'associate-address': { slots: 'one', resource: null, receipt: /^eipassoc-[0-9a-f]{8,17}$/ },
} as const satisfies Record<string, CreationEntry>

export type CreationAction = keyof typeof CREATIONS

/**
 * Creations whose resource deliberately has no removal, because Qiln holds no
 * authority to delete it. Such a resource stays, billable, until it is deleted
 * outside Qiln.
 */
export const RETAINED: readonly CreationAction[] = ['create-volume']

/**
 * Declaration order is removal plan order. It is deliberately not the reverse
 * of creation order, and each entry names the creation it undoes. The instance
 * is terminated, and verified gone, before the security group and subnets that
 * its interface depends on.
 */
export const REMOVALS = {
  'disassociate-address': { undoes: 'associate-address' },
  'release-address': { undoes: 'allocate-address' },
  'terminate-instance': { undoes: 'run-instances' },
  'delete-key-pair': { undoes: 'import-key-pair' },
  'delete-group': { undoes: 'create-group' },
  'disassociate-subnet': { undoes: 'associate-subnet' },
  'delete-subnet': { undoes: 'create-subnet' },
  'delete-route-table': { undoes: 'create-route-table' },
  'detach-gateway': { undoes: 'attach-gateway' },
  'delete-gateway': { undoes: 'create-gateway' },
  'delete-vpc': { undoes: 'create-vpc' },
} as const satisfies Record<string, { undoes: CreationAction }>

export type RemovalAction = keyof typeof REMOVALS
export type Action = CreationAction | RemovalAction
export type Direction = 'creation' | 'removal'

/**
 * - removed: Qiln deletes it.
 * - retained: it stays by design.
 * - implicit: AWS creates and deletes it together with the instance.
 */
export type Disposition = 'removed' | 'retained' | 'implicit'

/**
 * Resources that AWS creates and deletes together with the instance. No
 * mutation response names them, so their identities are learned from the
 * observation that verifies the launch.
 */
export const IMPLICIT = {
  parent: 'run-instances',
  removal: 'terminate-instance',
  kinds: ['volume', 'interface'],
} as const satisfies { parent: CreationAction; removal: RemovalAction; kinds: readonly Kind[] }

export interface ResourceDescriptor {
  kind: Kind
  create: CreationAction
  remove: RemovalAction | null
}

function keysOf<T extends object>(record: T): (keyof T & string)[] {
  return Object.keys(record) as (keyof T & string)[]
}

export const CREATION_ACTIONS = keysOf(CREATIONS)
export const REMOVAL_ACTIONS = keysOf(REMOVALS)
export const RESOURCES: readonly ResourceDescriptor[] = CREATION_ACTIONS.flatMap(create => {
  const kind = CREATIONS[create].resource
  if (kind === null) {
    return []
  }
  const removals = REMOVAL_ACTIONS.filter(remove => REMOVALS[remove].undoes === create)
  const retained = RETAINED.includes(create)
  if (removals.length !== (retained ? 0 : 1)) {
    throw new Error(`Resource creation '${create}' must have ${retained ? 'no removal' : 'exactly one removal'}.`)
  }
  return [{ kind, create, remove: removals.at(0) ?? null }]
})

if (REMOVALS[IMPLICIT.removal].undoes !== IMPLICIT.parent) {
  throw new Error('The implicit resources must be removed by the removal of their parent.')
}

export function isAction(value: unknown): value is Action {
  return typeof value === 'string' && (Object.hasOwn(CREATIONS, value) || Object.hasOwn(REMOVALS, value))
}

export function isKind(value: unknown): value is Kind {
  return typeof value === 'string' && Object.hasOwn(KIND_IDS, value)
}

function isCreation(action: Action): action is CreationAction {
  return Object.hasOwn(CREATIONS, action)
}

export function directionOf(action: Action): Direction {
  return isCreation(action) ? 'creation' : 'removal'
}

export function undoes(action: Action): CreationAction | null {
  return isCreation(action) ? null : REMOVALS[action].undoes
}

export function slotCount(action: Action, shape: Shape): number {
  const { slots } = CREATIONS[isCreation(action) ? action : REMOVALS[action].undoes]
  return slots === 'one' ? 1 : slots === 'zone' ? shape.zones : shape.ingress
}

export function receiptPattern(action: Action): RegExp | null {
  return isCreation(action) ? CREATIONS[action].receipt : null
}

export function resourceCount(shape: Shape): number {
  return RESOURCES.reduce((total, { create }) => total + slotCount(create, shape), 0) + IMPLICIT.kinds.length
}
