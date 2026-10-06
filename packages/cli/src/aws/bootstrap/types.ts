import { catalog } from '../../diagnostic/catalog'
import type { InstallerErrorCode } from '../../diagnostic/error'
import {
  hasKeys,
  isFailureCode,
  isIdentity,
  isRecord,
  isTimestamp,
  validName,
  validRegion,
  type AwsFailureCode,
  type AwsIdentity,
} from '../types'
import { arn, isReview } from './policy'

export interface RootIdentity {
  accountId: string
  arn: string
}

export interface RootInspection {
  identity: RootIdentity
  expiresAt: string
  mfaConfigured: boolean
}

export interface PolicyReview {
  versionId: string
  document: string
  sha256: string
}

export interface Readiness {
  passwordResetRequired: boolean | null
  mfaDevices: number
  accessKeys: number
}

export const PHASES = [
  'login',
  'inspected',
  'approved',
  'creating',
  'created',
  'attaching',
  'attached',
  'granting',
  'granted',
  'password',
  'handoff',
  'ready',
  'cleaned',
  'saved',
] as const

export type BootstrapPhase = (typeof PHASES)[number]

export interface BootstrapRecord {
  version: 1
  id: string
  name: string
  region: string
  phase: BootstrapPhase
  root: RootInspection | null
  review: PolicyReview | null
  operator: AwsIdentity | null
  readiness: Readiness | null
  approvedAt: string | null
  startedAt: string
  updatedAt: string
  failureCode: InstallerErrorCode | null
  termination: 'confirmed' | 'unconfirmed'
  cleanup: 'pending' | 'completed' | 'unconfirmed'
}

export interface Proposal {
  operationId: string
  accountId: string
  operatorName: string
  operatorArn: string
  managedPolicyArn: string
  managedPolicy: PolicyReview
  inlinePolicyName: string
  inlinePolicy: string
  mfaDeviceNames: readonly string[]
  mutations: readonly string[]
}

export type BootstrapAction = 'inspect' | 'create' | 'attach' | 'grant' | 'password' | 'readiness'

export interface BootstrapRequest {
  kind: BootstrapAction
  operationId: string
  region: string
}

export type BootstrapResult =
  | {
      kind: 'inspection'
      root: RootInspection
      review: PolicyReview
    }
  | {
      kind: 'operator'
      identity: AwsIdentity
    }
  | {
      kind: 'done'
      action: 'attach' | 'grant' | 'password'
    }
  | {
      kind: 'readiness'
      readiness: Readiness
    }

export type BootstrapReply =
  | {
      ok: true
      result: BootstrapResult
    }
  | {
      ok: false
      code: AwsFailureCode
    }

export function isOperationId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
}

export function isRootIdentity(value: unknown): value is RootIdentity {
  return (
    isRecord(value) &&
    hasKeys(value, ['accountId', 'arn']) &&
    typeof value.accountId === 'string' &&
    /^[0-9]{12}$/.test(value.accountId) &&
    value.arn === `arn:aws:iam::${value.accountId}:root`
  )
}

export function isRootInspection(value: unknown): value is RootInspection {
  return (
    isRecord(value) &&
    hasKeys(value, ['identity', 'expiresAt', 'mfaConfigured']) &&
    isRootIdentity(value.identity) &&
    isTimestamp(value.expiresAt) &&
    typeof value.mfaConfigured === 'boolean'
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

export function isPhase(value: unknown): value is BootstrapPhase {
  return PHASES.some(phase => phase === value)
}

function isInstallerCode(value: unknown): value is InstallerErrorCode {
  return typeof value === 'string' && Object.hasOwn(catalog, value)
}

export function isBootstrapRecord(value: unknown): value is BootstrapRecord {
  if (
    !isRecord(value) ||
    !hasKeys(value, [
      'version',
      'id',
      'name',
      'region',
      'phase',
      'root',
      'review',
      'operator',
      'readiness',
      'approvedAt',
      'startedAt',
      'updatedAt',
      'failureCode',
      'termination',
      'cleanup',
    ]) ||
    value.version !== 1 ||
    !isOperationId(value.id) ||
    typeof value.name !== 'string' ||
    !validName(value.name) ||
    typeof value.region !== 'string' ||
    !validRegion(value.region) ||
    !isPhase(value.phase) ||
    (value.root !== null && !isRootInspection(value.root)) ||
    (value.review !== null && !isReview(value.review)) ||
    (value.operator !== null && !isIdentity(value.operator)) ||
    (value.readiness !== null && !isReadiness(value.readiness)) ||
    (value.approvedAt !== null && !isTimestamp(value.approvedAt)) ||
    !isTimestamp(value.startedAt) ||
    !isTimestamp(value.updatedAt) ||
    (value.failureCode !== null && !isInstallerCode(value.failureCode)) ||
    (value.termination !== 'confirmed' && value.termination !== 'unconfirmed') ||
    !['pending', 'completed', 'unconfirmed'].includes(String(value.cleanup))
  ) {
    return false
  }
  const phase = PHASES.indexOf(value.phase)
  if ((value.root === null) !== (value.review === null)) {
    return false
  }
  if (phase >= PHASES.indexOf('inspected') && (value.root === null || value.review === null)) {
    return false
  }
  if (
    phase >= PHASES.indexOf('approved') &&
    (value.approvedAt === null || value.root === null || !value.root.mfaConfigured)
  ) {
    return false
  }
  if (phase >= PHASES.indexOf('created') && value.operator === null) {
    return false
  }
  if (
    value.operator !== null &&
    (value.root === null ||
      value.operator.accountId !== value.root.identity.accountId ||
      value.operator.arn !== arn(value.root.identity.accountId, value.name))
  ) {
    return false
  }
  if (phase >= PHASES.indexOf('ready') && (value.readiness === null || !ready(value.readiness))) {
    return false
  }
  if (phase >= PHASES.indexOf('cleaned') && (value.cleanup !== 'completed' || value.termination !== 'confirmed')) {
    return false
  }
  if (value.cleanup === 'completed' && value.termination !== 'confirmed') {
    return false
  }
  if (value.cleanup === 'completed' && value.failureCode === null && phase < PHASES.indexOf('cleaned')) {
    return false
  }
  return true
}

export function isBootstrapRequest(value: unknown): value is BootstrapRequest {
  return (
    isRecord(value) &&
    hasKeys(value, ['kind', 'operationId', 'region']) &&
    ['inspect', 'create', 'attach', 'grant', 'password', 'readiness'].some(kind => kind === value.kind) &&
    isOperationId(value.operationId) &&
    typeof value.region === 'string' &&
    validRegion(value.region)
  )
}

export function isBootstrapResult(value: unknown): value is BootstrapResult {
  if (!isRecord(value)) {
    return false
  }
  switch (value.kind) {
    case 'inspection':
      return hasKeys(value, ['kind', 'root', 'review']) && isRootInspection(value.root) && isReview(value.review)
    case 'operator':
      return hasKeys(value, ['kind', 'identity']) && isIdentity(value.identity)
    case 'done':
      return (
        hasKeys(value, ['kind', 'action']) && ['attach', 'grant', 'password'].some(action => action === value.action)
      )
    case 'readiness':
      return hasKeys(value, ['kind', 'readiness']) && isReadiness(value.readiness)
    default:
      return false
  }
}

export function isBootstrapReply(value: unknown): value is BootstrapReply {
  if (!isRecord(value)) {
    return false
  }
  if (value.ok === true) {
    return hasKeys(value, ['ok', 'result']) && isBootstrapResult(value.result)
  }
  return value.ok === false && hasKeys(value, ['ok', 'code']) && isFailureCode(value.code)
}
