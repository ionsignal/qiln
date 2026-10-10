import { hasKeys, isRecord } from '../guards'
import { COMMON_CODES, replyGuard, type ChildReply } from '../child/protocol'
import { isAuthentication, validRegion, type AwsAuthentication } from '../types'

export interface Request {
  kind: 'identity'
  region: string
}

/** Failures specific to this child, in addition to the common ones. */
export const FAILURES = [
  'AWS_SSO_UNSUPPORTED',
  'AWS_PROFILE_INVALID',
  'AWS_ROOT_REFUSED',
  'AWS_PRINCIPAL_UNSUPPORTED',
  'AWS_IDENTITY_INVALID',
] as const

export const CODES = [...COMMON_CODES, ...FAILURES] as const

export type Code = (typeof CODES)[number]

export type Reply = ChildReply<AwsAuthentication, Code>

export function isRequest(value: unknown): value is Request {
  return (
    isRecord(value) &&
    hasKeys(value, ['kind', 'region']) &&
    value.kind === 'identity' &&
    typeof value.region === 'string' &&
    validRegion(value.region)
  )
}

export const isReply = replyGuard(isAuthentication, CODES)
