import { AWS_RECORD_VERSION, AWS_SPEC } from '../spec'
import { isInstallerErrorCode, type InstallerErrorCode } from '../../diagnostic/error'
import { hasKeys, isOperationId, isRecord, isTimestamp } from '../../guards'
import { sameJson } from '../../json'
import { operatorArn } from '../operator'
import { policyArn } from '../permission/policy'
import { isFingerprint } from '../../ssh/key'
import {
  isAccountId,
  isIdentity,
  isPermissionMetadata,
  isPolicyBinding,
  validName,
  validRegion,
  type AwsIdentity,
  type PermissionMetadata,
  type PolicyBinding,
} from '../types'
import { contains, validCidr, validSource } from './cidr'
import {
  directionOf,
  isAction,
  isKind,
  KIND_IDS,
  receiptPattern,
  resourceCount,
  slotCount,
  type Action,
  type Kind,
} from './graph'
import { shapeOf } from './topology'
import { isHostKey, type HostKey } from './hostkey'
import { isHostPlan, type HostPlan } from './host/types'

export interface Tag {
  Key: string
  Value: string
}

export interface Binding {
  accountId: string
  operator: AwsIdentity
  creationId: string
  foundation: PolicyBinding
  region: string
}

export interface Placement {
  id: string
  name: string
}

export interface Zone extends Placement {
  cidr: string
}

export interface Ingress {
  port: number
  cidr: string
}

/**
 * Where the data volume comes from. A new volume is created under an
 * idempotency token. A reused volume is the retained volume of a previous
 * deployment, recorded by identity and by the tags it already carries. This
 * deployment never creates it, so no creation receipt exists for it.
 */
export type VolumeSource =
  | { kind: 'new'; token: string }
  | { kind: 'reuse'; from: string; volumeId: string; tags: Tag[] }

export interface HostIntent {
  plan: HostPlan
  keyName: string
  launchToken: string
  volume: VolumeSource
}

export interface Approval {
  approvedAt: string
  approvedBy: AwsIdentity
  cidr: string
  tenancy: 'default'
  zones: Zone[]
  ingress: Ingress[]
  tags: Tag[]
  permission: PermissionMetadata
  host: HostIntent
}

/**
 * Identity of the locally generated administrative key. The fingerprint is the
 * canonical SHA-256 form of the public key. It is the only key evidence that AWS
 * observation compares against, so local key files are never needed to observe
 * or remove AWS resources.
 */
export interface AdminKey {
  algorithm: 'ed25519'
  fingerprint: string
  generatedAt: string
}

/**
 * `unattempted` and `rejected` are definite refusals of one call, `blocked`
 * is a removal refused for dependencies, and `uncertain` keeps any effect open.
 */
export type FailureOutcome = 'unattempted' | 'rejected' | 'blocked' | 'uncertain'

export interface Failure {
  outcome: FailureOutcome
  code: InstallerErrorCode
  termination: 'confirmed' | 'unconfirmed'
  recordedAt: string
}

/**
 * One fenced provider call. The ledger is append-only: `returned`, `failure`,
 * and `verifiedAt` are each set once and never rewritten.
 */
export interface Step {
  id: string
  action: Action
  slot: number
  removal: number | null
  fencedAt: string
  returned: {
    returnedAt: string
    resourceId: string | null
  } | null
  failure: Failure | null
  verifiedAt: string | null
}

export interface Removal {
  approvedAt: string
  observation: Observation
}

export type ObservedState = 'present' | 'absent' | 'changed'

export interface ObservedResource {
  kind: Kind
  id: string
  state: ObservedState
}

/**
 * The root volume and primary interface that AWS created with the instance.
 * No mutation response names them, so they are observation evidence.
 */
export interface Implicit {
  rootVolumeId: string
  interfaceId: string
}

export interface ImplicitEvidence extends Implicit {
  observedAt: string
}

/**
 * `implicit` is the relationship the instance reported when it was observed
 * present, and null when no single root volume and interface were reported.
 */
export interface Observation {
  observedAt: string
  resources: ObservedResource[]
  implicit: Implicit | null
}

/**
 * Point-in-time AWS status evidence for the recorded instance. Only a passing
 * read is ever retained, so the guard accepts nothing but these literals. It
 * says nothing about reachability, SSH access, or guest state.
 */
export interface Health {
  instanceId: string
  checkedAt: string
  instanceState: 'running'
  system: 'ok'
  instance: 'ok'
  attachedEbs: 'ok'
}

/**
 * The retained data volume of this deployment now belongs to a later
 * deployment, which answers for it. Historical removal evidence is untouched.
 */
export interface Handoff {
  to: string
  at: string
}

/**
 * Accounting and recovery evidence, not a resumable checkpoint. Phases,
 * effects, and plans are derived from these facts and never stored. The alias
 * is local metadata and never an AWS tag. `previous` is the immutable ID of the
 * deployment whose alias this one takes over; it is set at approval and never
 * rewritten. `implicit` is set once, by the observation that verifies the
 * launch, and never rewritten. `adminKey` is set once, before any step, and
 * never rewritten or regenerated. `health` is set once, after every creation
 * step is verified and before any removal, in a write that changes nothing
 * else. `hostKey` is set once in the same way, as the server's pinned SSH host
 * key. It is AWS-reported console evidence, not guest attestation, and it is
 * distinct from `adminKey`. `handoff` is set once, in a write that changes
 * nothing else, after removal left the data volume retained and a later
 * deployment took it over.
 *
 * The `version` covers every constant, format rule, and graph declaration
 * order that the guards and the audit consult, such as the zone limit, tag and
 * key-name formats, the lifecycle invariants of the host plan, the
 * administrative key binding, the health evidence, the host-key pin, and the
 * creation and removal order. Version 1 is the baseline of a one-time
 * disposable development reset, before any release, so no earlier layout has a
 * reader. From the first release, changing any of them needs a version bump
 * and an explicit versioned reader. Records are never migrated silently, and a
 * stored launch plan is judged structurally, never rebuilt from today's
 * compute constants or checked against today's permission ceilings.
 */
export interface Deployment {
  version: typeof AWS_RECORD_VERSION.deployment
  id: string
  alias: string
  previous: string | null
  connection: string
  binding: Binding
  approval: Approval
  adminKey: AdminKey | null
  hostKey: HostKey | null
  termination: 'confirmed' | 'unconfirmed'
  steps: Step[]
  removals: Removal[]
  implicit: ImplicitEvidence | null
  latest: Observation | null
  health: Health | null
  handoff: Handoff | null
  createdAt: string
}

const OBSERVED_STATES = ['present', 'absent', 'changed'] as const
const FAILURE_OUTCOMES = ['unattempted', 'rejected', 'blocked', 'uncertain'] as const
const ZONE_ID = /^[a-z]+[0-9]-az[0-9]+$/
const ZONE_NAME = /^[a-z]+-[a-z]+-[0-9]+[a-z]$/
const INTERNET = '0.0.0.0/0'
const MAXIMUM_OBSERVED = resourceCount({ zones: AWS_SPEC.deployment.maximumZones, ingress: 0 })

export function requiredTags(operator: string, deploymentId: string): Tag[] {
  return [
    { Key: 'qiln:operator', Value: operator },
    { Key: 'qiln:deployment', Value: deploymentId },
    { Key: 'qiln:managed-by', Value: 'qiln-cli' },
  ]
}

export function hostKeyName(deploymentId: string): string {
  return `qiln-${deploymentId}`
}

export function isReceipt(action: Action, resourceId: unknown): boolean {
  const pattern = receiptPattern(action)
  return pattern === null ? resourceId === null : typeof resourceId === 'string' && pattern.test(resourceId)
}

function isTermination(value: unknown): value is 'confirmed' | 'unconfirmed' {
  return value === 'confirmed' || value === 'unconfirmed'
}

export function isPlacement(value: unknown): value is Placement {
  return (
    isRecord(value) &&
    hasKeys(value, ['id', 'name']) &&
    typeof value.id === 'string' &&
    ZONE_ID.test(value.id) &&
    typeof value.name === 'string' &&
    ZONE_NAME.test(value.name)
  )
}

function isTag(value: unknown): value is Tag {
  return (
    isRecord(value) &&
    hasKeys(value, ['Key', 'Value']) &&
    typeof value.Key === 'string' &&
    value.Key.length >= 1 &&
    value.Key.length <= 128 &&
    typeof value.Value === 'string' &&
    value.Value.length <= 256
  )
}

function isTags(value: unknown): value is Tag[] {
  return Array.isArray(value) && value.length <= 50 && value.every(isTag)
}

/**
 * Zones are judged structurally: ascending unique placements whose subnets
 * lie inside the VPC network. The subnet prefix policy is deliberately not
 * consulted, so it can change without making stored records unreadable.
 */
function isZones(value: unknown, cidr: string): value is Zone[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > AWS_SPEC.deployment.maximumZones) {
    return false
  }
  const zones: unknown[] = value
  const subnets = new Set<string>()
  let previous = ''
  return zones.every(zone => {
    if (
      !isRecord(zone) ||
      !hasKeys(zone, ['id', 'name', 'cidr']) ||
      typeof zone.cidr !== 'string' ||
      !contains(cidr, zone.cidr) ||
      subnets.has(zone.cidr)
    ) {
      return false
    }
    const placement = { id: zone.id, name: zone.name }
    if (!isPlacement(placement) || placement.id <= previous) {
      return false
    }
    previous = placement.id
    subnets.add(zone.cidr)
    return true
  })
}

function isIngressRule(value: unknown): value is Ingress {
  return (
    isRecord(value) &&
    hasKeys(value, ['port', 'cidr']) &&
    typeof value.port === 'number' &&
    Number.isSafeInteger(value.port) &&
    value.port >= 1 &&
    value.port <= 65_535 &&
    typeof value.cidr === 'string' &&
    (value.cidr === INTERNET || validSource(value.cidr))
  )
}

/**
 * The first rule is the administrator's network and is never the whole
 * internet. Which ports are opened is not judged against today's policy.
 */
function isIngress(value: unknown): value is Ingress[] {
  if (!Array.isArray(value) || value.length === 0) {
    return false
  }
  const rules: unknown[] = value
  const administrator = rules[0]
  return isIngressRule(administrator) && validSource(administrator.cidr) && rules.every(isIngressRule)
}

function isBinding(value: unknown, connection: string): value is Binding {
  return (
    isRecord(value) &&
    hasKeys(value, ['accountId', 'operator', 'creationId', 'foundation', 'region']) &&
    isAccountId(value.accountId) &&
    isIdentity(value.operator) &&
    value.operator.accountId === value.accountId &&
    value.operator.arn === operatorArn(value.accountId, connection) &&
    isOperationId(value.creationId) &&
    isPolicyBinding(value.foundation) &&
    value.foundation.arn === policyArn(value.accountId, connection, 'foundation') &&
    typeof value.region === 'string' &&
    validRegion(value.region)
  )
}

/**
 * A reused volume is identified by the previous deployment and the volume ID.
 * Its tags are recorded verbatim, because they are the original creator's and
 * may differ from this deployment's.
 */
function isVolumeSource(value: unknown): value is VolumeSource {
  if (!isRecord(value)) {
    return false
  }
  switch (value.kind) {
    case 'new':
      return hasKeys(value, ['kind', 'token']) && isOperationId(value.token)
    case 'reuse':
      return (
        hasKeys(value, ['kind', 'from', 'volumeId', 'tags']) &&
        isOperationId(value.from) &&
        typeof value.volumeId === 'string' &&
        KIND_IDS.volume.test(value.volumeId) &&
        isTags(value.tags)
      )
    default:
      return false
  }
}

function isHandoff(value: unknown): value is Handoff {
  return (
    isRecord(value) &&
    hasKeys(value, ['to', 'at']) &&
    isOperationId(value.to) &&
    isTimestamp(value.at)
  )
}

/**
 * The plan is judged structurally here, and `isApproval` then requires it to
 * agree with the approval. It is never rebuilt from today's constants. Tokens
 * are UUIDs, well inside the 64-character ClientToken limit, and the launch and
 * a new volume's creation never share one.
 */
function isHostIntent(value: unknown, id: string): value is HostIntent {
  return (
    isRecord(value) &&
    hasKeys(value, ['plan', 'keyName', 'launchToken', 'volume']) &&
    isHostPlan(value.plan) &&
    value.keyName === hostKeyName(id) &&
    isOperationId(value.launchToken) &&
    isVolumeSource(value.volume) &&
    (value.volume.kind !== 'new' || value.launchToken !== value.volume.token)
  )
}

function isApproval(value: unknown, binding: Binding, id: string): value is Approval {
  return (
    isRecord(value) &&
    hasKeys(value, ['approvedAt', 'approvedBy', 'cidr', 'tenancy', 'zones', 'ingress', 'tags', 'permission', 'host']) &&
    isTimestamp(value.approvedAt) &&
    isIdentity(value.approvedBy) &&
    sameJson(value.approvedBy, binding.operator) &&
    typeof value.cidr === 'string' &&
    validCidr(value.cidr) &&
    value.tenancy === 'default' &&
    isZones(value.zones, value.cidr) &&
    isIngress(value.ingress) &&
    isTags(value.tags) &&
    sameJson(value.tags, requiredTags(binding.operator.arn, id)) &&
    isPermissionMetadata(value.permission) &&
    isHostIntent(value.host, id) &&
    value.host.plan.region === binding.region &&
    value.host.plan.cidr === value.cidr &&
    sameJson(value.host.plan.zones, value.zones) &&
    sameJson(value.host.plan.ingress, value.ingress)
  )
}

function isAdminKey(value: unknown): value is AdminKey {
  return (
    isRecord(value) &&
    hasKeys(value, ['algorithm', 'fingerprint', 'generatedAt']) &&
    value.algorithm === 'ed25519' &&
    isFingerprint(value.fingerprint) &&
    isTimestamp(value.generatedAt)
  )
}

function isFailure(value: unknown, action: Action): value is Failure {
  return (
    isRecord(value) &&
    hasKeys(value, ['outcome', 'code', 'termination', 'recordedAt']) &&
    FAILURE_OUTCOMES.some(
      outcome => outcome === value.outcome && (outcome !== 'blocked' || directionOf(action) === 'removal'),
    ) &&
    isInstallerErrorCode(value.code) &&
    isTermination(value.termination) &&
    isTimestamp(value.recordedAt)
  )
}

function isReturned(value: unknown, action: Action): boolean {
  return (
    isRecord(value) &&
    hasKeys(value, ['returnedAt', 'resourceId']) &&
    isTimestamp(value.returnedAt) &&
    isReceipt(action, value.resourceId)
  )
}

function isStep(value: unknown): value is Step {
  if (
    !isRecord(value) ||
    !hasKeys(value, ['id', 'action', 'slot', 'removal', 'fencedAt', 'returned', 'failure', 'verifiedAt']) ||
    !isOperationId(value.id) ||
    !isAction(value.action) ||
    typeof value.slot !== 'number' ||
    !Number.isSafeInteger(value.slot) ||
    value.slot < 0 ||
    (value.removal === null) !== (directionOf(value.action) === 'creation') ||
    (value.removal !== null &&
      (typeof value.removal !== 'number' || !Number.isSafeInteger(value.removal) || value.removal < 0)) ||
    !isTimestamp(value.fencedAt) ||
    (value.returned !== null && !isReturned(value.returned, value.action)) ||
    (value.failure !== null && !isFailure(value.failure, value.action)) ||
    (value.verifiedAt !== null && !isTimestamp(value.verifiedAt))
  ) {
    return false
  }
  return (value.returned === null || value.failure === null) && (value.verifiedAt === null || value.returned !== null)
}

function isSteps(value: unknown): value is Step[] {
  return Array.isArray(value) && value.length <= AWS_SPEC.deployment.maximumSteps && value.every(isStep)
}

function isObserved(value: unknown): value is ObservedResource {
  return (
    isRecord(value) &&
    hasKeys(value, ['kind', 'id', 'state']) &&
    isKind(value.kind) &&
    typeof value.id === 'string' &&
    KIND_IDS[value.kind].test(value.id) &&
    OBSERVED_STATES.some(state => state === value.state)
  )
}

function isImplicit(value: unknown): value is Implicit {
  return (
    isRecord(value) &&
    hasKeys(value, ['rootVolumeId', 'interfaceId']) &&
    typeof value.rootVolumeId === 'string' &&
    KIND_IDS.volume.test(value.rootVolumeId) &&
    typeof value.interfaceId === 'string' &&
    KIND_IDS.interface.test(value.interfaceId)
  )
}

function isImplicitEvidence(value: unknown): value is ImplicitEvidence {
  return (
    isRecord(value) &&
    hasKeys(value, ['rootVolumeId', 'interfaceId', 'observedAt']) &&
    isImplicit({ rootVolumeId: value.rootVolumeId, interfaceId: value.interfaceId }) &&
    isTimestamp(value.observedAt)
  )
}

export function isObservation(value: unknown): value is Observation {
  return (
    isRecord(value) &&
    hasKeys(value, ['observedAt', 'resources', 'implicit']) &&
    isTimestamp(value.observedAt) &&
    Array.isArray(value.resources) &&
    value.resources.length <= MAXIMUM_OBSERVED &&
    value.resources.every(isObserved) &&
    (value.implicit === null || isImplicit(value.implicit))
  )
}

export function isHealth(value: unknown): value is Health {
  return (
    isRecord(value) &&
    hasKeys(value, ['instanceId', 'checkedAt', 'instanceState', 'system', 'instance', 'attachedEbs']) &&
    typeof value.instanceId === 'string' &&
    KIND_IDS.instance.test(value.instanceId) &&
    isTimestamp(value.checkedAt) &&
    value.instanceState === 'running' &&
    value.system === 'ok' &&
    value.instance === 'ok' &&
    value.attachedEbs === 'ok'
  )
}

function isRemoval(value: unknown): value is Removal {
  return (
    isRecord(value) &&
    hasKeys(value, ['approvedAt', 'observation']) &&
    isTimestamp(value.approvedAt) &&
    isObservation(value.observation)
  )
}

function isRemovals(value: unknown): value is Removal[] {
  return Array.isArray(value) && value.length <= AWS_SPEC.deployment.maximumSteps && value.every(isRemoval)
}

export function isDeployment(value: unknown): value is Deployment {
  if (
    !isRecord(value) ||
    !hasKeys(value, [
      'version',
      'id',
      'alias',
      'previous',
      'connection',
      'binding',
      'approval',
      'adminKey',
      'hostKey',
      'termination',
      'steps',
      'removals',
      'implicit',
      'latest',
      'health',
      'handoff',
      'createdAt',
    ]) ||
    value.version !== AWS_RECORD_VERSION.deployment ||
    !isOperationId(value.id) ||
    typeof value.alias !== 'string' ||
    !validName(value.alias) ||
    (value.previous !== null && !isOperationId(value.previous)) ||
    typeof value.connection !== 'string' ||
    !validName(value.connection) ||
    !isBinding(value.binding, value.connection) ||
    !isApproval(value.approval, value.binding, value.id) ||
    (value.adminKey !== null && !isAdminKey(value.adminKey)) ||
    !isTermination(value.termination) ||
    !isSteps(value.steps) ||
    !isRemovals(value.removals) ||
    (value.implicit !== null && !isImplicitEvidence(value.implicit)) ||
    (value.latest !== null && !isObservation(value.latest)) ||
    (value.health !== null && !isHealth(value.health)) ||
    (value.hostKey !== null && !isHostKey(value.hostKey)) ||
    (value.handoff !== null && !isHandoff(value.handoff)) ||
    !isTimestamp(value.createdAt)
  ) {
    return false
  }
  const approval = value.approval
  const removals = value.removals
  const shape = shapeOf(approval)
  const { volume } = approval.host
  return (
    (volume.kind !== 'reuse' || volume.from === value.previous) &&
    value.previous !== value.id &&
    value.steps.every(
      step => step.slot < slotCount(step.action, shape) && (step.removal === null || step.removal < removals.length),
    )
  )
}
