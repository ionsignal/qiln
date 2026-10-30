import { z } from 'zod'
import { hasKeys, isRecord } from '../../guards'
import { operationId } from '../../journal/step'
import { childReplySchema, COMMON_CODES } from '../child/protocol'
import { isPolicyKey, type PolicyMap } from '../permission/keys'
import { isIdentities, type PolicyIdentity } from '../permission/policy'
import { regionSchema } from '../types'
import {
  isInspection,
  isMutationResult,
  isReadiness,
  type Inspection,
  type MutationResult,
  type Readiness,
} from './types'

export const ACTIONS = ['inspect', 'mutate', 'verify-mutation', 'readiness', 'verify'] as const

export type Action = (typeof ACTIONS)[number]

export const requestSchema = z.strictObject({
  kind: z.enum(ACTIONS),
  operationId,
  region: regionSchema,
})

export type Request = z.infer<typeof requestSchema>

export type Result =
  | {
      kind: 'inspection'
      inspection: Inspection
    }
  | MutationResult
  | {
      kind: 'readiness'
      readiness: Readiness
    }
  | {
      kind: 'verified'
      policies: PolicyMap<PolicyIdentity>
    }

export const FAILURES = [
  'AWS_ROOT_REQUIRED',
  'AWS_ROOT_MFA_REQUIRED',
  'AWS_BOOTSTRAP_CONFLICT',
  'AWS_BOOTSTRAP_OWNERSHIP_INVALID',
  'AWS_BOOTSTRAP_POLICY_CHANGED',
  'AWS_BOOTSTRAP_INSPECTION_FAILED',
  'AWS_BOOTSTRAP_VERIFICATION_FAILED',
  'AWS_BOOTSTRAP_READINESS_UNKNOWN',
  'AWS_BOOTSTRAP_PASSWORD_REJECTED',
  'AWS_BOOTSTRAP_PASSWORD_UNAVAILABLE',
  'AWS_PERMISSION_STATE_INVALID',
  'AWS_PERMISSION_RECORDED',
  'AWS_PERMISSION_POLICY_TOO_LARGE',
  'AWS_PERMISSION_VERSION_LIMIT',
  'AWS_LOCK_CHANGED',
  'AWS_SSO_UNSUPPORTED',
  'AWS_PROFILE_INVALID',
  'AWS_ROOT_REFUSED',
  'AWS_PRINCIPAL_UNSUPPORTED',
  'AWS_IDENTITY_INVALID',
  'AWS_IDENTITY_MISMATCH',
] as const

export const CODES = [...COMMON_CODES, ...FAILURES] as const

export type Code = (typeof CODES)[number]

function checkResult(value: unknown): value is Result {
  if (!isRecord(value)) {
    return false
  }
  switch (value.kind) {
    case 'inspection':
      return hasKeys(value, ['kind', 'inspection']) && isInspection(value.inspection)
    case 'operator':
      return isMutationResult(value, 'create-user')
    case 'done':
      return (
        (value.action === 'attach-signin' || value.action === 'grant-self') &&
        isMutationResult(value, value.action)
      )
    case 'policy':
      return (
        (value.action === 'create-policy' ||
          value.action === 'attach-policy' ||
          value.action === 'replace-policy') &&
        isPolicyKey(value.key) &&
        isMutationResult(value, value.action, value.key)
      )
    case 'password':
      return isMutationResult(value, 'password')
    case 'readiness':
      return hasKeys(value, ['kind', 'readiness']) && isReadiness(value.readiness)
    case 'verified':
      return hasKeys(value, ['kind', 'policies']) && isIdentities(value.policies)
    default:
      return false
  }
}

const resultSchema = z.custom<Result>(checkResult)

export const replySchema = childReplySchema(resultSchema, CODES)

export type Reply = z.infer<typeof replySchema>
