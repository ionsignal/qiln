import { createHash } from 'node:crypto'
import { InstallerError } from '../../diagnostic/error'
import { hasKeys, isRecord } from '../../guards'
import { document } from './document'
import { invalidPermission } from './invalid'
import { operatorName } from '../operator'
import { POLICY_KEYS, POLICY_PATH, type PolicyKey, type PolicyMap } from './keys'

export const POLICY_LIMITS = Object.freeze({
  maximumCharacters: 6_144,
  maximumVersions: 5,
})

export interface PolicyDocument {
  document: string
  sha256: string
}

/**
 * Live identity of one policy's default version. The document itself lives once,
 * in the approval; prior documents stay in IAM's retained versions.
 */
export interface PolicyIdentity {
  arn: string
  id: string
  versionId: string
  sha256: string
}

export interface PolicySnapshot {
  policy: PolicyIdentity | null
  versions: string[]
  attached: boolean
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function policyName(connection: string, key: PolicyKey): string {
  return `${operatorName(connection)}-${key}`
}

export function policyArn(accountId: string, connection: string, key: PolicyKey): string {
  if (!/^[0-9]{12}$/.test(accountId)) {
    return invalidPermission()
  }
  return `arn:aws:iam::${accountId}:policy${POLICY_PATH}${policyName(connection, key)}`
}

export function validVersionId(value: unknown): value is string {
  return typeof value === 'string' && /^v[1-9][0-9]{0,9}$/.test(value)
}

export function normalize(value: string | undefined): string {
  const normalized = document(value)
  // Canonical JSON has no formatting whitespace. Counting all remaining
  // characters also avoids understating whitespace inside string values.
  if (!/^[\x20-\x7e]+$/.test(normalized) || normalized.length > POLICY_LIMITS.maximumCharacters) {
    throw new InstallerError({
      code: 'AWS_PERMISSION_POLICY_TOO_LARGE',
    })
  }
  return normalized
}

export function emptySnapshot(): PolicySnapshot {
  return {
    policy: null,
    versions: [],
    attached: false,
  }
}

export function isPolicyDocument(value: unknown): value is PolicyDocument {
  if (
    !isRecord(value) ||
    !hasKeys(value, ['document', 'sha256']) ||
    typeof value.document !== 'string' ||
    typeof value.sha256 !== 'string'
  ) {
    return false
  }
  try {
    return normalize(value.document) === value.document && digest(value.document) === value.sha256
  } catch {
    return false
  }
}

export function isPolicy(value: unknown): value is PolicyIdentity {
  return (
    isRecord(value) &&
    hasKeys(value, ['arn', 'id', 'versionId', 'sha256']) &&
    typeof value.arn === 'string' &&
    /^arn:aws:iam::[0-9]{12}:policy\/[A-Za-z0-9+=,.@_/-]+$/.test(value.arn) &&
    typeof value.id === 'string' &&
    /^[A-Za-z0-9]{1,128}$/.test(value.id) &&
    validVersionId(value.versionId) &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256)
  )
}

export function isIdentities(value: unknown): value is PolicyMap<PolicyIdentity> {
  return isRecord(value) && hasKeys(value, POLICY_KEYS) && POLICY_KEYS.every(key => isPolicy(value[key]))
}

export function isSnapshot(value: unknown): value is PolicySnapshot {
  if (
    !isRecord(value) ||
    !hasKeys(value, ['policy', 'versions', 'attached']) ||
    (value.policy !== null && !isPolicy(value.policy)) ||
    !Array.isArray(value.versions) ||
    value.versions.some(version => !validVersionId(version)) ||
    new Set(value.versions).size !== value.versions.length ||
    value.versions.length > POLICY_LIMITS.maximumVersions ||
    typeof value.attached !== 'boolean'
  ) {
    return false
  }
  if (value.policy === null) {
    return value.versions.length === 0 && !value.attached
  }
  return value.versions.length > 0 && value.versions.includes(value.policy.versionId)
}

export function isSnapshots(value: unknown): value is PolicyMap<PolicySnapshot> {
  return isRecord(value) && hasKeys(value, POLICY_KEYS) && POLICY_KEYS.every(key => isSnapshot(value[key]))
}
