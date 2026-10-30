import { isInstallerErrorCode, type InstallerErrorCode } from '../../diagnostic/error'
import { hasKeys, isOperationId, isRecord, isTimestamp } from '../../guards'
import { sameJson } from '../../json'
import { operatorArn } from '../operator'
import { isPolicyKey, POLICY_KEYS, type PolicyKey, type PolicyMap } from '../permission/keys'
import { isPolicy, isSnapshots, policyArn, type PolicyIdentity, type PolicySnapshot } from '../permission/policy'
import { isEvidence, type PermissionEvidence, type PermissionSpec } from '../permission/spec'
import { AWS_RECORD_VERSION } from '../spec'
import {
  identitySchema,
  isAccountId,
  permissionMetadataSchema,
  validName,
  validRegion,
  type AwsIdentity,
  type PermissionMetadata,
} from '../types'
import { isReview } from './policy'

// Phase 1b converts this file. Until then these adapt the shared schemas to the
// narrowing that the guards below rely on.
function isIdentity(value: unknown): value is AwsIdentity {
  return identitySchema.safeParse(value).success
}

function isPermissionMetadata(value: unknown): value is PermissionMetadata {
  return permissionMetadataSchema.safeParse(value).success
}

export interface Target {
  accountId: string
  connection: string
  creationId: string
}

export interface Binding extends Target {
  operator: AwsIdentity
}

export interface PolicyReview {
  versionId: string
  document: string
  sha256: string
}

export interface LoginObservation {
  createdAt: string
  passwordResetRequired: boolean | null
}

export interface PasswordReceipt {
  createdAt: string
  delivered: boolean
}

export interface Readiness {
  passwordResetRequired: boolean | null
  mfaDevices: number
  accessKeys: number
}

export interface PermissionInspection {
  signIn: PolicyReview
  login: LoginObservation | null
  policies: PolicyMap<PolicySnapshot>
}

export interface RootIdentity {
  accountId: string
  arn: string
}

export interface RootInspection {
  identity: RootIdentity
  expiresAt: string
  mfaConfigured: boolean
}

export interface Inspection {
  root: RootInspection
  signIn: PolicyReview
  before: PermissionInspection | null
}

export type OperationKind = 'onboard' | 'maintain'

/**
 * `deploymentRegion` is the target the connection will record. It is displayed
 * independently of the permission scope, which is not regional.
 */
export interface Proposal {
  operationId: string
  kind: OperationKind
  operatorArn: string
  deploymentRegion: string
  inspection: Inspection
  permission: PermissionSpec
}

export interface Approval {
  approvedAt: string
  inspection: Inspection
  permission: PermissionEvidence
}

export const MUTATIONS = [
  'create-user',
  'attach-signin',
  'grant-self',
  'create-policy',
  'attach-policy',
  'replace-policy',
  'password',
] as const

export type MutationAction = (typeof MUTATIONS)[number]

export const POLICY_ACTIONS = ['create-policy', 'attach-policy', 'replace-policy'] as const

export type PolicyAction = (typeof POLICY_ACTIONS)[number]

export function isMutationAction(value: unknown): value is MutationAction {
  return MUTATIONS.some(action => action === value)
}

export function isPolicyAction(action: MutationAction): action is PolicyAction {
  return POLICY_ACTIONS.some(candidate => candidate === action)
}

export interface MutationProgress {
  action: MutationAction
  key: PolicyKey | null
  phase: 'started' | 'verified'
}

export type MutationResult =
  | {
      kind: 'operator'
      identity: AwsIdentity
    }
  | {
      kind: 'done'
      action: 'attach-signin' | 'grant-self'
    }
  | {
      kind: 'policy'
      action: PolicyAction
      key: PolicyKey
      policy: PolicyIdentity
    }
  | {
      kind: 'password'
      receipt: PasswordReceipt
    }

/**
 * This is the outstanding mutation, not a history. Returned evidence is saved
 * before read verification; an unresolved intent is never resumed automatically.
 * `key` names the policy of a policy action and is null otherwise.
 */
export interface Mutation {
  id: string
  action: MutationAction
  key: PolicyKey | null
  approvedAt: string
  returned: MutationResult | null
  verifiedAt: string | null
}

export interface Pending {
  version: typeof AWS_RECORD_VERSION.pending
  id: string
  name: string
  kind: OperationKind
  region: string
  accountId: string | null
  creationId: string
  operator: AwsIdentity | null
  policies: PolicyMap<PolicyIdentity | null>
  approval: Approval | null
  mutation: Mutation | null
  password: PasswordReceipt | null
  verified: PermissionMetadata | null
  termination: 'confirmed' | 'unconfirmed'
  cleanup: 'pending' | 'completed' | 'unconfirmed'
  failureCode: InstallerErrorCode | null
  startedAt: string
}

export function isLoginObservation(value: unknown): value is LoginObservation {
  return (
    isRecord(value) &&
    hasKeys(value, ['createdAt', 'passwordResetRequired']) &&
    isTimestamp(value.createdAt) &&
    (value.passwordResetRequired === null || typeof value.passwordResetRequired === 'boolean')
  )
}

export function isPasswordReceipt(value: unknown): value is PasswordReceipt {
  return (
    isRecord(value) &&
    hasKeys(value, ['createdAt', 'delivered']) &&
    isTimestamp(value.createdAt) &&
    typeof value.delivered === 'boolean'
  )
}

export function isReadiness(value: unknown): value is Readiness {
  return (
    isRecord(value) &&
    hasKeys(value, ['passwordResetRequired', 'mfaDevices', 'accessKeys']) &&
    (value.passwordResetRequired === null || typeof value.passwordResetRequired === 'boolean') &&
    typeof value.mfaDevices === 'number' &&
    Number.isSafeInteger(value.mfaDevices) &&
    value.mfaDevices >= 0 &&
    typeof value.accessKeys === 'number' &&
    Number.isSafeInteger(value.accessKeys) &&
    value.accessKeys >= 0
  )
}

export function ready(value: Readiness): boolean {
  return value.passwordResetRequired === false && value.accessKeys === 0
}

export function isRootIdentity(value: unknown): value is RootIdentity {
  return (
    isRecord(value) &&
    hasKeys(value, ['accountId', 'arn']) &&
    isAccountId(value.accountId) &&
    value.arn === `arn:aws:iam::${value.accountId}:root`
  )
}

function isRootInspection(value: unknown): value is RootInspection {
  return (
    isRecord(value) &&
    hasKeys(value, ['identity', 'expiresAt', 'mfaConfigured']) &&
    isRootIdentity(value.identity) &&
    isTimestamp(value.expiresAt) &&
    typeof value.mfaConfigured === 'boolean'
  )
}

function isPermissionInspection(value: unknown): value is PermissionInspection {
  return (
    isRecord(value) &&
    hasKeys(value, ['signIn', 'login', 'policies']) &&
    isReview(value.signIn) &&
    (value.login === null || isLoginObservation(value.login)) &&
    isSnapshots(value.policies)
  )
}

export function isInspection(value: unknown): value is Inspection {
  return (
    isRecord(value) &&
    hasKeys(value, ['root', 'signIn', 'before']) &&
    isRootInspection(value.root) &&
    isReview(value.signIn) &&
    (value.before === null ||
      (isPermissionInspection(value.before) && sameJson(value.before.signIn, value.signIn)))
  )
}

function isApproval(value: unknown): value is Approval {
  return (
    isRecord(value) &&
    hasKeys(value, ['approvedAt', 'inspection', 'permission']) &&
    isTimestamp(value.approvedAt) &&
    isInspection(value.inspection) &&
    value.inspection.root.mfaConfigured &&
    isEvidence(value.permission)
  )
}

export function isMutationResult(
  value: unknown,
  action: MutationAction,
  key: PolicyKey | null = null,
): value is MutationResult {
  if (!isRecord(value)) {
    return false
  }
  switch (action) {
    case 'create-user':
      return hasKeys(value, ['kind', 'identity']) && value.kind === 'operator' && isIdentity(value.identity)
    case 'attach-signin':
    case 'grant-self':
      return hasKeys(value, ['kind', 'action']) && value.kind === 'done' && value.action === action
    case 'create-policy':
    case 'attach-policy':
    case 'replace-policy':
      return (
        hasKeys(value, ['kind', 'action', 'key', 'policy']) &&
        value.kind === 'policy' &&
        value.action === action &&
        key !== null &&
        value.key === key &&
        isPolicy(value.policy)
      )
    case 'password':
      return hasKeys(value, ['kind', 'receipt']) && value.kind === 'password' && isPasswordReceipt(value.receipt)
  }
}

function isMutation(value: unknown): value is Mutation {
  if (
    !isRecord(value) ||
    !hasKeys(value, ['id', 'action', 'key', 'approvedAt', 'returned', 'verifiedAt']) ||
    !isOperationId(value.id) ||
    !isMutationAction(value.action) ||
    (value.key !== null && !isPolicyKey(value.key)) ||
    !isTimestamp(value.approvedAt) ||
    (value.verifiedAt !== null && !isTimestamp(value.verifiedAt))
  ) {
    return false
  }
  const key = value.key
  if (
    (key !== null) !== isPolicyAction(value.action) ||
    (value.returned !== null && !isMutationResult(value.returned, value.action, key)) ||
    (value.verifiedAt !== null && value.returned === null)
  ) {
    return false
  }
  return (
    value.verifiedAt === null ||
    !isRecord(value.returned) ||
    value.returned.kind !== 'password' ||
    (isPasswordReceipt(value.returned.receipt) && value.returned.receipt.delivered)
  )
}

function isRetainedPolicies(value: unknown): value is PolicyMap<PolicyIdentity | null> {
  return (
    isRecord(value) &&
    hasKeys(value, POLICY_KEYS) &&
    POLICY_KEYS.every(key => value[key] === null || isPolicy(value[key]))
  )
}

export function isPending(value: unknown): value is Pending {
  if (
    !isRecord(value) ||
    !hasKeys(value, [
      'version',
      'id',
      'name',
      'kind',
      'region',
      'accountId',
      'creationId',
      'operator',
      'policies',
      'approval',
      'mutation',
      'password',
      'verified',
      'termination',
      'cleanup',
      'failureCode',
      'startedAt',
    ]) ||
    value.version !== AWS_RECORD_VERSION.pending ||
    !isOperationId(value.id) ||
    typeof value.name !== 'string' ||
    !validName(value.name) ||
    (value.kind !== 'onboard' && value.kind !== 'maintain') ||
    typeof value.region !== 'string' ||
    !validRegion(value.region) ||
    (value.accountId !== null && !isAccountId(value.accountId)) ||
    !isOperationId(value.creationId) ||
    (value.operator !== null && !isIdentity(value.operator)) ||
    !isRetainedPolicies(value.policies) ||
    (value.approval !== null && !isApproval(value.approval)) ||
    (value.mutation !== null && !isMutation(value.mutation)) ||
    (value.password !== null && !isPasswordReceipt(value.password)) ||
    (value.verified !== null && !isPermissionMetadata(value.verified)) ||
    (value.termination !== 'confirmed' && value.termination !== 'unconfirmed') ||
    !['pending', 'completed', 'unconfirmed'].includes(String(value.cleanup)) ||
    (value.failureCode !== null && !isInstallerErrorCode(value.failureCode)) ||
    !isTimestamp(value.startedAt)
  ) {
    return false
  }
  const name = value.name
  const accountId = value.accountId
  const policies = value.policies
  if (
    (value.kind === 'onboard' && value.creationId !== value.id) ||
    (value.kind === 'maintain' && (accountId === null || value.operator === null || value.password !== null)) ||
    (value.operator !== null &&
      (value.operator.accountId !== accountId ||
        value.operator.arn !== operatorArn(value.operator.accountId, name))) ||
    POLICY_KEYS.some(key => {
      const policy = policies[key]
      return policy !== null && (accountId === null || policy.arn !== policyArn(accountId, name, key))
    }) ||
    (value.cleanup === 'completed' && value.termination !== 'confirmed')
  ) {
    return false
  }
  const approval = value.approval
  if (approval === null) {
    return (
      value.mutation === null &&
      POLICY_KEYS.every(key => policies[key] === null) &&
      value.password === null &&
      value.verified === null
    )
  }
  if (
    approval.inspection.root.identity.accountId !== accountId ||
    (value.kind === 'onboard' ? approval.inspection.before !== null : approval.inspection.before?.login == null)
  ) {
    return false
  }
  const prior = approval.inspection.before?.policies
  if (
    prior &&
    POLICY_KEYS.some(key => {
      const policy = prior[key].policy
      return policy !== null && policy.arn !== policyArn(approval.inspection.root.identity.accountId, name, key)
    })
  ) {
    return false
  }
  const mutation = value.mutation
  if (mutation !== null) {
    if (value.kind === 'maintain' && !isPolicyAction(mutation.action)) {
      return false
    }
    const returned = mutation.returned
    if (
      (returned?.kind === 'operator' && !sameJson(returned.identity, value.operator)) ||
      (returned?.kind === 'policy' && !sameJson(returned.policy, policies[returned.key])) ||
      (returned?.kind === 'password' && !sameJson(returned.receipt, value.password))
    ) {
      return false
    }
  }
  const verified = value.verified
  if (verified !== null) {
    if (
      verified.version !== approval.permission.version ||
      verified.sha256 !== approval.permission.sha256 ||
      POLICY_KEYS.some(key => {
        const policy = policies[key]
        const verification = verified.policies[key]
        return (
          policy === null ||
          verification === undefined ||
          verification.policyVersion !== policy.versionId ||
          verification.sha256 !== policy.sha256 ||
          policy.sha256 !== approval.permission.policies[key].sha256
        )
      }) ||
      (mutation !== null && mutation.verifiedAt === null) ||
      (value.kind === 'onboard' && value.password?.delivered !== true)
    ) {
      return false
    }
  }
  return true
}
