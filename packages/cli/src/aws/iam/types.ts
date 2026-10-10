import { catalog } from '../../diagnostic/catalog'
import type { InstallerErrorCode } from '../../diagnostic/error'
import {
  isEvidence,
  isPolicy,
  isSnapshot,
  policyArn,
  type PermissionEvidence,
  type PermissionSpec,
  type PolicyIdentity,
  type PolicySnapshot,
} from '../foundation/policy'
import { hasKeys, isRecord } from '../guards'
import { sameJson } from '../json'
import { operatorArn } from '../operator'
import {
  isAccountId,
  isIdentity,
  isOperationId,
  isPermissionMetadata,
  isTimestamp,
  validName,
  validRegion,
  type AwsIdentity,
  type PermissionMetadata,
} from '../types'
import { isReview } from './policy'

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

export interface FoundationInspection {
  signIn: PolicyReview
  login: LoginObservation | null
  prior: PolicySnapshot
}

export interface FoundationChange {
  action: 'create' | 'attach' | 'replace'
  before: FoundationInspection
  policy: PolicyIdentity
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
  before: FoundationInspection | null
}

export type OperationKind = 'onboard' | 'maintain'

export interface Proposal {
  operationId: string
  kind: OperationKind
  operatorArn: string
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
  'create-foundation',
  'attach-foundation',
  'replace-foundation',
  'password',
] as const

export type MutationAction = (typeof MUTATIONS)[number]

export interface MutationProgress {
  action: MutationAction
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
      action: 'create-foundation' | 'attach-foundation' | 'replace-foundation'
      policy: PolicyIdentity
    }
  | {
      kind: 'password'
      receipt: PasswordReceipt
    }

/**
 * This is the outstanding mutation, not a history. Returned evidence is saved
 * before read verification; an unresolved intent is never resumed automatically.
 */
export interface Mutation {
  id: string
  action: MutationAction
  approvedAt: string
  before: FoundationInspection | null
  returned: MutationResult | null
  verifiedAt: string | null
}

export interface Pending {
  version: 1
  id: string
  name: string
  kind: OperationKind
  region: string
  accountId: string | null
  creationId: string
  operator: AwsIdentity | null
  foundation: PolicyIdentity | null
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

function isFoundationInspection(value: unknown): value is FoundationInspection {
  return (
    isRecord(value) &&
    hasKeys(value, ['signIn', 'login', 'prior']) &&
    isReview(value.signIn) &&
    (value.login === null || isLoginObservation(value.login)) &&
    isSnapshot(value.prior)
  )
}

export function isInspection(value: unknown): value is Inspection {
  return (
    isRecord(value) &&
    hasKeys(value, ['root', 'signIn', 'before']) &&
    isRootInspection(value.root) &&
    isReview(value.signIn) &&
    (value.before === null ||
      (isFoundationInspection(value.before) && sameJson(value.before.signIn, value.signIn)))
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

export function isMutationResult(value: unknown, action: MutationAction): value is MutationResult {
  if (!isRecord(value)) {
    return false
  }
  switch (action) {
    case 'create-user':
      return hasKeys(value, ['kind', 'identity']) && value.kind === 'operator' && isIdentity(value.identity)
    case 'attach-signin':
    case 'grant-self':
      return hasKeys(value, ['kind', 'action']) && value.kind === 'done' && value.action === action
    case 'create-foundation':
    case 'attach-foundation':
    case 'replace-foundation':
      return (
        hasKeys(value, ['kind', 'action', 'policy']) &&
        value.kind === 'policy' &&
        value.action === action &&
        isPolicy(value.policy)
      )
    case 'password':
      return hasKeys(value, ['kind', 'receipt']) && value.kind === 'password' && isPasswordReceipt(value.receipt)
  }
}

function isMutation(value: unknown): value is Mutation {
  if (
    !isRecord(value) ||
    !hasKeys(value, ['id', 'action', 'approvedAt', 'before', 'returned', 'verifiedAt']) ||
    !isOperationId(value.id) ||
    !MUTATIONS.some(action => action === value.action) ||
    !isTimestamp(value.approvedAt) ||
    (value.before !== null && !isFoundationInspection(value.before)) ||
    (value.returned !== null && !isMutationResult(value.returned, value.action as MutationAction)) ||
    (value.verifiedAt !== null && !isTimestamp(value.verifiedAt))
  ) {
    return false
  }
  const foundation = ['create-foundation', 'attach-foundation', 'replace-foundation'].includes(String(value.action))
  return (
    foundation === (value.before !== null) &&
    (value.verifiedAt === null || value.returned !== null) &&
    (value.verifiedAt === null ||
      !isRecord(value.returned) ||
      value.returned.kind !== 'password' ||
      (isPasswordReceipt(value.returned.receipt) && value.returned.receipt.delivered))
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
      'foundation',
      'approval',
      'mutation',
      'password',
      'verified',
      'termination',
      'cleanup',
      'failureCode',
      'startedAt',
    ]) ||
    value.version !== 1 ||
    !isOperationId(value.id) ||
    typeof value.name !== 'string' ||
    !validName(value.name) ||
    (value.kind !== 'onboard' && value.kind !== 'maintain') ||
    typeof value.region !== 'string' ||
    !validRegion(value.region) ||
    (value.accountId !== null && !isAccountId(value.accountId)) ||
    !isOperationId(value.creationId) ||
    (value.operator !== null && !isIdentity(value.operator)) ||
    (value.foundation !== null && !isPolicy(value.foundation)) ||
    (value.approval !== null && !isApproval(value.approval)) ||
    (value.mutation !== null && !isMutation(value.mutation)) ||
    (value.password !== null && !isPasswordReceipt(value.password)) ||
    (value.verified !== null && !isPermissionMetadata(value.verified)) ||
    (value.termination !== 'confirmed' && value.termination !== 'unconfirmed') ||
    !['pending', 'completed', 'unconfirmed'].includes(String(value.cleanup)) ||
    (value.failureCode !== null &&
      (typeof value.failureCode !== 'string' || !Object.hasOwn(catalog, value.failureCode))) ||
    !isTimestamp(value.startedAt)
  ) {
    return false
  }
  if (
    (value.kind === 'onboard' && value.creationId !== value.id) ||
    (value.kind === 'maintain' && (value.accountId === null || value.operator === null || value.password !== null)) ||
    (value.operator !== null &&
      (value.operator.accountId !== value.accountId ||
        value.operator.arn !== operatorArn(value.operator.accountId, value.name))) ||
    (value.foundation !== null &&
      (value.accountId === null || value.foundation.arn !== policyArn(value.accountId, value.name))) ||
    (value.cleanup === 'completed' && value.termination !== 'confirmed')
  ) {
    return false
  }
  const approval = value.approval
  if (approval === null) {
    return value.mutation === null && value.foundation === null && value.password === null && value.verified === null
  }
  if (
    approval.inspection.root.identity.accountId !== value.accountId ||
    approval.permission.region !== value.region ||
    (value.kind === 'onboard' ? approval.inspection.before !== null : approval.inspection.before?.login == null)
  ) {
    return false
  }
  const observedPolicy = approval.inspection.before?.prior.policy
  if (observedPolicy && observedPolicy.arn !== policyArn(approval.inspection.root.identity.accountId, value.name)) {
    return false
  }
  const mutation = value.mutation
  if (mutation !== null) {
    if (
      (value.kind === 'maintain' &&
        !['create-foundation', 'attach-foundation', 'replace-foundation'].includes(mutation.action)) ||
      (mutation.before !== null && !sameJson(mutation.before.signIn, approval.inspection.signIn))
    ) {
      return false
    }
    const returned = mutation.returned
    if (
      (returned?.kind === 'operator' && !sameJson(returned.identity, value.operator)) ||
      (returned?.kind === 'policy' && !sameJson(returned.policy, value.foundation)) ||
      (returned?.kind === 'password' && !sameJson(returned.receipt, value.password))
    ) {
      return false
    }
  }
  if (value.verified !== null) {
    if (
      value.foundation === null ||
      value.verified.version !== approval.permission.version ||
      value.verified.policyVersion !== value.foundation.versionId ||
      value.verified.sha256 !== approval.permission.sha256 ||
      value.foundation.document !== approval.permission.document ||
      value.foundation.sha256 !== approval.permission.sha256 ||
      (mutation !== null && mutation.verifiedAt === null) ||
      (value.kind === 'onboard' && value.password?.delivered !== true)
    ) {
      return false
    }
  }
  return true
}
