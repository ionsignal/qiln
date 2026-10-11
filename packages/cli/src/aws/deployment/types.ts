import { catalog } from '../../diagnostic/catalog'
import type { InstallerErrorCode } from '../../diagnostic/error'
import { policyArn } from '../foundation/policy'
import { hasKeys, isRecord } from '../guards'
import { sameJson } from '../json'
import { operatorArn } from '../operator'
import { AWS_SPEC } from '../spec'
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
import { validCidr } from './cidr'

export interface Tag {
  Key: string
  Value: string
}

/** Immutable identities the deployment is bound to; never inferred from a connection name. */
export interface Binding {
  accountId: string
  operator: AwsIdentity
  creationId: string
  foundation: PolicyBinding
  region: string
}

export interface Approval {
  approvedAt: string
  approvedBy: AwsIdentity
  cidr: string
  tenancy: 'default'
  tags: Tag[]
  permission: PermissionMetadata
}

/**
 * `not-attempted` and `rejected` are definite refusals of one call, `blocked`
 * is a removal refused for dependencies, and `uncertain` keeps any effect open.
 */
export type FailureOutcome = 'not-attempted' | 'rejected' | 'blocked' | 'uncertain'

/** Terminal for its operation: it keeps the termination evidence seen when it was written. */
export interface Failure {
  outcome: FailureOutcome
  code: InstallerErrorCode
  termination: 'confirmed' | 'unconfirmed'
  recordedAt: string
}

/** Local projection of a provider VPC. Absent optional fields are never read as success. */
export interface VpcObservation {
  state: 'pending' | 'available' | 'deleting'
  ownerId: string
  cidr: string
  tenancy: 'default' | 'dedicated' | 'host'
  isDefault: boolean
  tags: Tag[]
  extraCidrs: number
}

export interface Observation {
  observedAt: string
  vpcId: string
  /** Null means the recorded ID was observed absent. */
  vpc: VpcObservation | null
}

export interface Fenced {
  id: string
  fencedAt: string
  returned: object | null
  failure: Failure | null
}

export interface Creation extends Fenced {
  returned: {
    vpcId: string
    returnedAt: string
  } | null
}

/** The SDK reports no delete result, so `returned` only records a completed call. */
export interface Removal extends Fenced {
  approval: {
    approvedAt: string
    observation: Observation
  }
  returned: {
    returnedAt: string
  } | null
}

/**
 * Accounting and recovery evidence, not a resumable checkpoint. Phases and
 * effects are derived from these facts and never stored.
 */
export interface Deployment {
  version: 1
  id: string
  connection: string
  binding: Binding
  approval: Approval
  /** State of the most recent child; failures keep their own copy. */
  termination: 'confirmed' | 'unconfirmed'
  creation: Creation | null
  removals: Removal[]
  latest: Observation | null
  verified: Observation | null
  createdAt: string
}

const VPC_STATES = ['pending', 'available', 'deleting'] as const
const TENANCIES = ['default', 'dedicated', 'host'] as const
const FAILURE_OUTCOMES = ['not-attempted', 'rejected', 'blocked', 'uncertain'] as const

export function requiredTags(operator: string, deploymentId: string): Tag[] {
  return [
    { Key: 'qiln:operator', Value: operator },
    { Key: 'qiln:deployment', Value: deploymentId },
    { Key: 'qiln:managed-by', Value: 'qiln-cli' },
  ]
}

/** Whether an observation shows the approved VPC, available and unchanged. */
export function verifies(observation: Observation, context: Pick<Deployment, 'binding' | 'approval'>): boolean {
  const vpc = observation.vpc
  return (
    vpc !== null &&
    vpc.state === 'available' &&
    vpc.ownerId === context.binding.accountId &&
    vpc.cidr === context.approval.cidr &&
    vpc.tenancy === context.approval.tenancy &&
    !vpc.isDefault &&
    vpc.extraCidrs === 0 &&
    context.approval.tags.every(tag => vpc.tags.some(actual => actual.Key === tag.Key && actual.Value === tag.Value))
  )
}

function isTermination(value: unknown): value is 'confirmed' | 'unconfirmed' {
  return value === 'confirmed' || value === 'unconfirmed'
}

export function isVpcId(value: unknown): value is string {
  return typeof value === 'string' && /^vpc-[0-9a-f]{8,17}$/.test(value)
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

function isVpcObservation(value: unknown): value is VpcObservation {
  return (
    isRecord(value) &&
    hasKeys(value, ['state', 'ownerId', 'cidr', 'tenancy', 'isDefault', 'tags', 'extraCidrs']) &&
    VPC_STATES.some(state => state === value.state) &&
    isAccountId(value.ownerId) &&
    typeof value.cidr === 'string' &&
    /^[0-9./]{1,18}$/.test(value.cidr) &&
    TENANCIES.some(tenancy => tenancy === value.tenancy) &&
    typeof value.isDefault === 'boolean' &&
    isTags(value.tags) &&
    typeof value.extraCidrs === 'number' &&
    Number.isSafeInteger(value.extraCidrs) &&
    value.extraCidrs >= 0
  )
}

export function isObservation(value: unknown): value is Observation {
  return (
    isRecord(value) &&
    hasKeys(value, ['observedAt', 'vpcId', 'vpc']) &&
    isTimestamp(value.observedAt) &&
    isVpcId(value.vpcId) &&
    (value.vpc === null || isVpcObservation(value.vpc))
  )
}

function isFailure(value: unknown, removal: boolean): value is Failure {
  return (
    isRecord(value) &&
    hasKeys(value, ['outcome', 'code', 'termination', 'recordedAt']) &&
    FAILURE_OUTCOMES.some(outcome => outcome === value.outcome && (removal || outcome !== 'blocked')) &&
    typeof value.code === 'string' &&
    Object.hasOwn(catalog, value.code) &&
    isTermination(value.termination) &&
    isTimestamp(value.recordedAt)
  )
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
    value.foundation.arn === policyArn(value.accountId, connection) &&
    typeof value.region === 'string' &&
    validRegion(value.region)
  )
}

function isApproval(value: unknown, binding: Binding, id: string): value is Approval {
  return (
    isRecord(value) &&
    hasKeys(value, ['approvedAt', 'approvedBy', 'cidr', 'tenancy', 'tags', 'permission']) &&
    isTimestamp(value.approvedAt) &&
    isIdentity(value.approvedBy) &&
    sameJson(value.approvedBy, binding.operator) &&
    typeof value.cidr === 'string' &&
    validCidr(value.cidr) &&
    value.tenancy === 'default' &&
    isTags(value.tags) &&
    sameJson(value.tags, requiredTags(binding.operator.arn, id)) &&
    isPermissionMetadata(value.permission)
  )
}

/** A response may coexist only with a later uncertain outcome, never with a refusal of the same call. */
function consistent(returned: unknown, failure: Failure | null): boolean {
  return failure === null || failure.outcome === 'uncertain' || returned === null
}

function isCreation(value: unknown): value is Creation {
  if (
    !isRecord(value) ||
    !hasKeys(value, ['id', 'fencedAt', 'returned', 'failure']) ||
    !isOperationId(value.id) ||
    !isTimestamp(value.fencedAt) ||
    (value.returned !== null &&
      !(
        isRecord(value.returned) &&
        hasKeys(value.returned, ['vpcId', 'returnedAt']) &&
        isVpcId(value.returned.vpcId) &&
        isTimestamp(value.returned.returnedAt)
      )) ||
    (value.failure !== null && !isFailure(value.failure, false))
  ) {
    return false
  }
  return consistent(value.returned, value.failure)
}

function isRemoval(value: unknown): value is Removal {
  if (
    !isRecord(value) ||
    !hasKeys(value, ['id', 'approval', 'fencedAt', 'returned', 'failure']) ||
    !isOperationId(value.id) ||
    !(
      isRecord(value.approval) &&
      hasKeys(value.approval, ['approvedAt', 'observation']) &&
      isTimestamp(value.approval.approvedAt) &&
      isObservation(value.approval.observation)
    ) ||
    !isTimestamp(value.fencedAt) ||
    (value.returned !== null &&
      !(isRecord(value.returned) && hasKeys(value.returned, ['returnedAt']) && isTimestamp(value.returned.returnedAt))) ||
    (value.failure !== null && !isFailure(value.failure, true))
  ) {
    return false
  }
  return consistent(value.returned, value.failure)
}

function isRemovals(value: unknown): value is Removal[] {
  return Array.isArray(value) && value.length <= AWS_SPEC.deployment.maximumRemovals && value.every(isRemoval)
}

export function isDeployment(value: unknown): value is Deployment {
  if (
    !isRecord(value) ||
    !hasKeys(value, [
      'version',
      'id',
      'connection',
      'binding',
      'approval',
      'termination',
      'creation',
      'removals',
      'latest',
      'verified',
      'createdAt',
    ]) ||
    value.version !== 1 ||
    !isOperationId(value.id) ||
    typeof value.connection !== 'string' ||
    !validName(value.connection) ||
    !isBinding(value.binding, value.connection) ||
    !isApproval(value.approval, value.binding, value.id) ||
    !isTermination(value.termination) ||
    (value.creation !== null && !isCreation(value.creation)) ||
    !isRemovals(value.removals) ||
    (value.latest !== null && !isObservation(value.latest)) ||
    (value.verified !== null && !isObservation(value.verified)) ||
    !isTimestamp(value.createdAt)
  ) {
    return false
  }
  const context = {
    binding: value.binding,
    approval: value.approval,
  }
  const vpcId = value.creation?.returned?.vpcId ?? null
  const removals = value.removals
  const latest = value.latest
  const verified = value.verified
  // Without a retained identity there is nothing to observe or remove.
  if (vpcId === null) {
    return removals.length === 0 && latest === null && verified === null
  }
  return (
    (latest === null || latest.vpcId === vpcId) &&
    (verified === null || (verified.vpcId === vpcId && verifies(verified, context))) &&
    removals.every(
      (removal, index) =>
        removal.approval.observation.vpcId === vpcId &&
        verifies(removal.approval.observation, context) &&
        // Only the newest attempt may be open; earlier ones were definite refusals.
        (index === removals.length - 1 ||
          (removal.returned === null && removal.failure !== null && removal.failure.outcome !== 'uncertain')),
    )
  )
}
