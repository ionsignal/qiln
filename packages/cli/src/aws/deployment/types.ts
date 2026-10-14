import { AWS_SPEC } from '../spec'
import { isInstallerErrorCode, type InstallerErrorCode } from '../../diagnostic/error'
import { policyArn } from '../permission/policy'
import { hasKeys, isRecord } from '../guards'
import { sameJson } from '../json'
import { operatorArn } from '../operator'
import {
  isAccountId,
  isIdentity,
  isOperationId,
  isPermissionMetadata,
  isPolicyBinding,
  isTimestamp,
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
import { isHostPlan, type HostPlan } from './host/types'
import { shapeOf } from './topology'

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

export interface HostIntent {
  plan: HostPlan
  keyName: string
  launchToken: string
  volumeToken: string
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
 * Accounting and recovery evidence, not a resumable checkpoint. Phases,
 * effects, and plans are derived from these facts and never stored. The alias
 * is local metadata, unique among records, and never an AWS tag. `implicit` is
 * set once, by the observation that verifies the launch, and never rewritten.
 *
 * The `version` covers every constant, format rule, and graph declaration
 * order that the guards and the audit consult, such as the zone limit, tag and
 * key-name formats, and the creation and removal order. Changing any of them
 * needs a version bump and an explicit versioned reader. Records are never
 * migrated silently, and a stored launch plan is judged structurally, never
 * rebuilt from today's compute constants.
 */
export interface Deployment {
  version: 4
  id: string
  alias: string
  connection: string
  binding: Binding
  approval: Approval
  termination: 'confirmed' | 'unconfirmed'
  steps: Step[]
  removals: Removal[]
  implicit: ImplicitEvidence | null
  latest: Observation | null
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
 * The plan is judged structurally here, and `isApproval` then requires it to
 * agree with the approval. It is never rebuilt from today's constants. Tokens
 * are UUIDs, well inside the 64-character ClientToken limit, and the two calls
 * never share one.
 */
function isHostIntent(value: unknown, id: string): value is HostIntent {
  return (
    isRecord(value) &&
    hasKeys(value, ['plan', 'keyName', 'launchToken', 'volumeToken']) &&
    isHostPlan(value.plan) &&
    value.keyName === hostKeyName(id) &&
    isOperationId(value.launchToken) &&
    isOperationId(value.volumeToken) &&
    value.launchToken !== value.volumeToken
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
      'connection',
      'binding',
      'approval',
      'termination',
      'steps',
      'removals',
      'implicit',
      'latest',
      'createdAt',
    ]) ||
    value.version !== 4 ||
    !isOperationId(value.id) ||
    typeof value.alias !== 'string' ||
    !validName(value.alias) ||
    typeof value.connection !== 'string' ||
    !validName(value.connection) ||
    !isBinding(value.binding, value.connection) ||
    !isApproval(value.approval, value.binding, value.id) ||
    !isTermination(value.termination) ||
    !isSteps(value.steps) ||
    !isRemovals(value.removals) ||
    (value.implicit !== null && !isImplicitEvidence(value.implicit)) ||
    (value.latest !== null && !isObservation(value.latest)) ||
    !isTimestamp(value.createdAt)
  ) {
    return false
  }
  const approval = value.approval
  const removals = value.removals
  const shape = shapeOf(approval)
  return value.steps.every(
    step => step.slot < slotCount(step.action, shape) && (step.removal === null || step.removal < removals.length),
  )
}
