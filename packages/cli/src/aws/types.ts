import { AWS_RECORD_VERSION } from './spec'
import { hasKeys, isRecord } from '../guards'
import {
  POLICY_KEYS,
  POLICY_PATH,
  bindingEntries,
  enrolledKeys,
  isPolicyKey,
  type PolicyBindings,
} from './permission/keys'

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

export interface PolicyBinding {
  arn: string
  id: string
}

export interface PolicyVerification {
  policyVersion: string
  sha256: string
}

/**
 * `sha256` is the digest of the complete verified set. Each policy keeps its own
 * verified default version and document digest beside it. Keys added after a
 * verification are absent until a later verification enrolls them.
 */
export interface PermissionMetadata {
  version: number
  sha256: string
  policies: PolicyBindings<PolicyVerification>
  verifiedAt: string
}

/**
 * `deploymentRegion` is the immutable concrete deployment target. It is
 * independent of the editable login default in `AwsConnection.region`.
 */
export interface ManagedOperator {
  creationId: string
  deploymentRegion: string
  policies: PolicyBindings<PolicyBinding>
  verified: PermissionMetadata
}

export interface AwsConnection {
  version: typeof AWS_RECORD_VERSION.connection
  name: string
  region: string
  identity: AwsIdentity
  createdAt: string
  managed: ManagedOperator | null
}

export function validName(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,47}$/.test(value)
}

export function validRegion(value: string): boolean {
  // This batch intentionally excludes non-commercial AWS partitions.
  return /^(af|ap|ca|eu|il|me|mx|sa|us)-[a-z]+-[1-9][0-9]*$/.test(value)
}

export function isOperationId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
}

export function isAccountId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{12}$/.test(value)
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
    !isAccountId(value.accountId) ||
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

export function isPolicyBinding(value: unknown): value is PolicyBinding {
  return (
    isRecord(value) &&
    hasKeys(value, ['arn', 'id']) &&
    typeof value.arn === 'string' &&
    /^arn:aws:iam::[0-9]{12}:policy\/[A-Za-z0-9+=,.@_/-]+$/.test(value.arn) &&
    typeof value.id === 'string' &&
    /^[A-Za-z0-9]{1,128}$/.test(value.id)
  )
}

function isPolicyVerification(value: unknown): value is PolicyVerification {
  return (
    isRecord(value) &&
    hasKeys(value, ['policyVersion', 'sha256']) &&
    typeof value.policyVersion === 'string' &&
    /^v[1-9][0-9]{0,9}$/.test(value.policyVersion) &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256)
  )
}

/**
 * Durable records tolerate key-set growth: `foundation` is required, and any
 * other present key must be a known one.
 */
function isBindings<T>(value: unknown, isEntry: (entry: unknown) => entry is T): value is PolicyBindings<T> {
  return (
    isRecord(value) &&
    Object.keys(value).every(key => isPolicyKey(key)) &&
    isEntry(value.foundation) &&
    POLICY_KEYS.every(key => !Object.hasOwn(value, key) || isEntry(value[key]))
  )
}

/**
 * Last verification remains readable when permission requirements or tooling
 * pins change. It is metadata, not a reconstruction of historical authority.
 */
export function isPermissionMetadata(value: unknown): value is PermissionMetadata {
  return (
    isRecord(value) &&
    hasKeys(value, ['version', 'sha256', 'policies', 'verifiedAt']) &&
    typeof value.version === 'number' &&
    Number.isSafeInteger(value.version) &&
    value.version >= 1 &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    isBindings(value.policies, isPolicyVerification) &&
    isTimestamp(value.verifiedAt)
  )
}

export function isManagedOperator(value: unknown): value is ManagedOperator {
  return (
    isRecord(value) &&
    hasKeys(value, ['creationId', 'deploymentRegion', 'policies', 'verified']) &&
    isOperationId(value.creationId) &&
    typeof value.deploymentRegion === 'string' &&
    validRegion(value.deploymentRegion) &&
    isBindings(value.policies, isPolicyBinding) &&
    isPermissionMetadata(value.verified) &&
    enrolledKeys(value.policies).join() === enrolledKeys(value.verified.policies).join()
  )
}

export function isConnection(value: unknown): value is AwsConnection {
  if (
    !isRecord(value) ||
    !hasKeys(value, ['version', 'name', 'region', 'identity', 'createdAt', 'managed']) ||
    value.version !== AWS_RECORD_VERSION.connection ||
    typeof value.name !== 'string' ||
    !validName(value.name) ||
    typeof value.region !== 'string' ||
    !validRegion(value.region) ||
    !isIdentity(value.identity) ||
    !isTimestamp(value.createdAt) ||
    (value.managed !== null && !isManagedOperator(value.managed))
  ) {
    return false
  }
  if (value.managed === null) {
    return true
  }
  const managed = value.managed
  const accountId = value.identity.accountId
  const operatorName = `qiln-${value.name}`
  return (
    value.identity.arn === `arn:aws:iam::${accountId}:user/qiln/operators/${operatorName}` &&
    bindingEntries(managed.policies).every(
      ([key, policy]) => policy.arn === `arn:aws:iam::${accountId}:policy${POLICY_PATH}${operatorName}-${key}`,
    )
  )
}
