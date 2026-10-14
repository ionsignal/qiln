import { InstallerError } from '../../diagnostic/error'
import { hasKeys, isRecord } from '../guards'
import { canonical, sameJson } from '../json'
import { validRegion, type AwsConnection } from '../types'
import { computePolicy } from './compute'
import { foundationPolicy } from './foundation'
import { POLICY_KEYS, policyMap, type PolicyMap } from './keys'
import {
  digest,
  emptySnapshot,
  isPolicyDocument,
  policyArn,
  type PolicyDocument,
  type PolicySnapshot,
} from './policy'

export const PERMISSION_VERSION = 6

export interface PermissionEvidence {
  version: number
  region: string
  policies: PolicyMap<PolicyDocument>
  sha256: string
}

export interface PermissionSpec extends PermissionEvidence {
  version: typeof PERMISSION_VERSION
}

export type Mode = 'enroll' | 'replace' | 'none'

const BUILDERS: PolicyMap<(accountId: string, region: string) => string> = {
  foundation: foundationPolicy,
  compute: computePolicy,
}

function invalid(): never {
  throw new InstallerError({
    code: 'AWS_PERMISSION_STATE_INVALID',
  })
}

function setDigest(policies: PolicyMap<PolicyDocument>): string {
  return digest(canonical(policyMap(key => policies[key].sha256)))
}

export function specification(accountId: string, connection: string, region: string): PermissionSpec {
  for (const key of POLICY_KEYS) {
    policyArn(accountId, connection, key)
  }
  if (!validRegion(region)) {
    return invalid()
  }
  const policies = policyMap(key => {
    const document = BUILDERS[key](accountId, region)
    return {
      document,
      sha256: digest(document),
    }
  })
  return {
    version: PERMISSION_VERSION,
    region,
    policies,
    sha256: setDigest(policies),
  }
}

function isDocuments(value: unknown): value is PolicyMap<PolicyDocument> {
  return isRecord(value) && hasKeys(value, POLICY_KEYS) && POLICY_KEYS.every(key => isPolicyDocument(value[key]))
}

/**
 * Historical evidence is structurally validated without reconstructing its
 * requirements. It establishes neither current compliance nor live IAM state.
 */
export function isEvidence(value: unknown): value is PermissionEvidence {
  return (
    isRecord(value) &&
    hasKeys(value, ['version', 'region', 'policies', 'sha256']) &&
    typeof value.version === 'number' &&
    Number.isSafeInteger(value.version) &&
    value.version >= 1 &&
    typeof value.region === 'string' &&
    validRegion(value.region) &&
    isDocuments(value.policies) &&
    value.sha256 === setDigest(value.policies)
  )
}

export function isSpec(value: unknown, accountId: string, connection: string): value is PermissionSpec {
  if (!isEvidence(value) || value.version !== PERMISSION_VERSION) {
    return false
  }
  try {
    return sameJson(value, specification(accountId, connection, value.region))
  } catch {
    return false
  }
}

export function reconciliationMode(prior: PolicySnapshot, desired: PolicyDocument): Mode {
  if (prior.policy === null) {
    return 'enroll'
  }
  return prior.policy.sha256 === desired.sha256 ? 'none' : 'replace'
}

export function reconciliation(prior: PolicyMap<PolicySnapshot> | null, desired: PermissionEvidence): PolicyMap<Mode> {
  return policyMap(key => reconciliationMode(prior?.[key] ?? emptySnapshot(), desired.policies[key]))
}

export function currentRequirement(connection: AwsConnection): PermissionSpec | null {
  if (!connection.managed) {
    return null
  }
  return specification(connection.identity.accountId, connection.name, connection.managed.permissionRegion)
}

/**
 * A recorded verification covers only the keys that existed when it was made,
 * so a current key without a binding or verification also requires review.
 */
export function reviewRequired(connection: AwsConnection): boolean {
  const desired = currentRequirement(connection)
  const managed = connection.managed
  if (desired === null || managed === null) {
    return false
  }
  const verified = managed.verified
  return (
    verified.version !== desired.version ||
    verified.sha256 !== desired.sha256 ||
    POLICY_KEYS.some(key => managed.policies[key] === undefined || verified.policies[key] === undefined)
  )
}
