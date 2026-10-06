import { AWS_SPEC } from './spec'

export type LoginFlow = 'browser' | 'remote'

export interface AwsIdentity {
  accountId: string
  arn: string
  userId: string
}

export interface AwsAuthentication {
  identity: AwsIdentity
  expiresAt: string
}

export interface AwsConnection {
  version: 1
  name: string
  region: string
  identity: AwsIdentity
  createdAt: string
  cliVersion: string
  sdkVersion: string
}

export type OperationPhase = 'login' | 'verified' | 'saved' | 'failed' | 'disconnecting'

export interface AwsOperation {
  version: 1
  id: string
  name: string
  region: string
  phase: OperationPhase
  identity: AwsIdentity | null
  startedAt: string
}

export interface AwsRequest {
  kind: 'identity'
  region: string
}

export const AWS_FAILURE_CODES = [
  'AWS_AUTH_FAILED',
  'AWS_ROOT_REQUIRED',
  'AWS_ROOT_MFA_REQUIRED',
  'AWS_BOOTSTRAP_STATE_INVALID',
  'AWS_BOOTSTRAP_CONFLICT',
  'AWS_BOOTSTRAP_OWNERSHIP_INVALID',
  'AWS_BOOTSTRAP_POLICY_CHANGED',
  'AWS_BOOTSTRAP_INSPECTION_FAILED',
  'AWS_BOOTSTRAP_VERIFICATION_FAILED',
  'AWS_BOOTSTRAP_READINESS_UNKNOWN',
  'AWS_BOOTSTRAP_PASSWORD_REJECTED',
  'AWS_BOOTSTRAP_PASSWORD_UNAVAILABLE',
  'AWS_AUTH_EXPIRED',
  'AWS_ACCESS_DENIED',
  'AWS_SSO_UNSUPPORTED',
  'AWS_PROFILE_INVALID',
  'AWS_ROOT_REFUSED',
  'AWS_PRINCIPAL_UNSUPPORTED',
  'AWS_IDENTITY_INVALID',
  'AWS_IDENTITY_MISMATCH',
  'AWS_REQUEST_FAILED',
] as const

export type AwsFailureCode = (typeof AWS_FAILURE_CODES)[number]

export type AwsReply =
  | {
      ok: true
      authentication: AwsAuthentication
    }
  | {
      ok: false
      code: AwsFailureCode
    }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function hasKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const keys = [...expected].sort()
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}

export function validName(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,47}$/.test(value)
}

export function validRegion(value: string): boolean {
  // This batch intentionally excludes non-commercial AWS partitions.
  return /^(af|ap|ca|eu|il|me|mx|sa|us)-[a-z]+-[1-9][0-9]*$/.test(value)
}

export function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }
  const timestamp = new Date(value)
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value
}

export function isIdentity(value: unknown): value is AwsIdentity {
  if (
    !isRecord(value) ||
    !hasKeys(value, ['accountId', 'arn', 'userId']) ||
    typeof value.accountId !== 'string' ||
    !/^[0-9]{12}$/.test(value.accountId) ||
    typeof value.arn !== 'string' ||
    typeof value.userId !== 'string' ||
    !/^[A-Za-z0-9]{1,128}$/.test(value.userId)
  ) {
    return false
  }
  const arn = /^arn:aws:iam::([0-9]{12}):user\/[A-Za-z0-9+=,.@_/-]+$/.exec(value.arn)
  return arn?.[1] === value.accountId
}

export function isAuthentication(value: unknown): value is AwsAuthentication {
  return (
    isRecord(value) &&
    hasKeys(value, ['identity', 'expiresAt']) &&
    isIdentity(value.identity) &&
    isTimestamp(value.expiresAt)
  )
}

export function isConnection(value: unknown): value is AwsConnection {
  return (
    isRecord(value) &&
    hasKeys(value, ['version', 'name', 'region', 'identity', 'createdAt', 'cliVersion', 'sdkVersion']) &&
    value.version === 1 &&
    typeof value.name === 'string' &&
    validName(value.name) &&
    typeof value.region === 'string' &&
    validRegion(value.region) &&
    isIdentity(value.identity) &&
    isTimestamp(value.createdAt) &&
    value.cliVersion === AWS_SPEC.cliVersion &&
    value.sdkVersion === AWS_SPEC.sdkVersion
  )
}

export function isOperation(value: unknown): value is AwsOperation {
  return (
    isRecord(value) &&
    hasKeys(value, ['version', 'id', 'name', 'region', 'phase', 'identity', 'startedAt']) &&
    value.version === 1 &&
    typeof value.id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.id) &&
    typeof value.name === 'string' &&
    validName(value.name) &&
    typeof value.region === 'string' &&
    validRegion(value.region) &&
    (value.phase === 'login' ||
      value.phase === 'verified' ||
      value.phase === 'saved' ||
      value.phase === 'failed' ||
      value.phase === 'disconnecting') &&
    (value.identity === null || isIdentity(value.identity)) &&
    isTimestamp(value.startedAt)
  )
}

export function isFailureCode(value: unknown): value is AwsFailureCode {
  return AWS_FAILURE_CODES.some(code => code === value)
}

export function isRequest(value: unknown): value is AwsRequest {
  return (
    isRecord(value) &&
    hasKeys(value, ['kind', 'region']) &&
    value.kind === 'identity' &&
    typeof value.region === 'string' &&
    validRegion(value.region)
  )
}

export function isReply(value: unknown): value is AwsReply {
  if (!isRecord(value)) {
    return false
  }
  if (value.ok === true) {
    return hasKeys(value, ['ok', 'authentication']) && isAuthentication(value.authentication)
  }
  return value.ok === false && hasKeys(value, ['ok', 'code']) && isFailureCode(value.code)
}
