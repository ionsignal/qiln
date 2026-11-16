import { hasKeys, isRecord } from '../../guards'
import { canonical, sameJson } from '../../json'
import type { AwsConnection } from '../types'
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

export const PERMISSION_VERSION = 1

export interface PermissionEvidence {
  version: number
  policies: PolicyMap<PolicyDocument>
  sha256: string
}

export interface PermissionSpec extends PermissionEvidence {
  version: typeof PERMISSION_VERSION
}

export type Mode = 'enroll' | 'replace' | 'none'

const BUILDERS: PolicyMap<(accountId: string) => string> = {
  foundation: foundationPolicy,
  compute: computePolicy,
}

function setDigest(policies: PolicyMap<PolicyDocument>): string {
  return digest(canonical(policyMap(key => policies[key].sha256)))
}

export function specification(accountId: string, connection: string): PermissionSpec {
  for (const key of POLICY_KEYS) {
    policyArn(accountId, connection, key)
  }
  const policies = policyMap(key => {
    const document = BUILDERS[key](accountId)
    return {
      document,
      sha256: digest(document),
    }
  })
  return {
    version: PERMISSION_VERSION,
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
    hasKeys(value, ['version', 'policies', 'sha256']) &&
    typeof value.version === 'number' &&
    Number.isSafeInteger(value.version) &&
    value.version >= 1 &&
    isDocuments(value.policies) &&
    value.sha256 === setDigest(value.policies)
  )
}

export function isSpec(value: unknown, accountId: string, connection: string): value is PermissionSpec {
  if (!isEvidence(value) || value.version !== PERMISSION_VERSION) {
    return false
  }
  try {
    return sameJson(value, specification(accountId, connection))
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

/**
 * Only a Qiln-created operator has recorded verification to compare. A recorded
 * verification covers only the keys that existed when it was made, so a current
 * key without a binding or verification also requires review.
 */
export function reviewRequired({ identity, name, authority }: AwsConnection): boolean {
  if (authority.kind !== 'created') {
    return false
  }
  const desired = specification(identity.accountId, name)
  const { verified } = authority
  return (
    verified.version !== desired.version ||
    verified.sha256 !== desired.sha256 ||
    POLICY_KEYS.some(key => authority.policies[key] === undefined || verified.policies[key] === undefined)
  )
}
