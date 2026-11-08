import { z } from 'zod'
import { AWS_SPEC } from '../spec'
import { operationId } from '../../journal/step'
import { certaintySchema, childReplySchema, COMMON_CODES, type Failure } from '../child/protocol'

export const FAILURES = [
  'DOMAIN_NOT_ATTEMPTED',
  'DOMAIN_SERVICE_REFUSED',
  'DOMAIN_SERVICE_LIMIT',
  'DOMAIN_SERVICE_UNAVAILABLE',
  'DOMAIN_RESPONSE_INVALID',
] as const

export const SERVICE_CODES = [
  'bad_request',
  'invalid_installation',
  'invalid_address',
  'invalid_csr',
  'invalid_proof',
  'principal_refused',
  'not_found',
  'limit_reached',
  'rate_limited',
  'busy',
  'identity_unavailable',
  'upstream_failure',
] as const

export const CODES = [...COMMON_CODES, ...FAILURES] as const

export type Code = (typeof CODES)[number]
export type ServiceCode = (typeof SERVICE_CODES)[number]

export interface ServiceFailure extends Failure<Code> {
  service?: ServiceCode
}

export const requestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('register'), deploymentId: operationId }),
  z.strictObject({ kind: z.literal('issue'), deploymentId: operationId, csr: z.base64().max(4_096) }),
])

export const registrationSchema = z.strictObject({
  label: z.string().regex(/^[a-z0-9]{12}$/),
  zone: z.literal(AWS_SPEC.domain.zone),
  address: z.ipv4(),
})

export const certificateSchema = z.strictObject({
  chain: z.string().min(1).max(AWS_SPEC.domain.maximumResponseBytes),
  notBefore: z.iso.datetime(),
  notAfter: z.iso.datetime(),
})

const resultSchema = z.discriminatedUnion('kind', [
  registrationSchema.extend({ kind: z.literal('registered') }),
  certificateSchema.extend({ kind: z.literal('issued') }),
])

const serviceFailureSchema = z.strictObject({
  ok: z.literal(false),
  code: z.enum(CODES),
  certainty: certaintySchema,
  service: z.enum(SERVICE_CODES),
})

export const replySchema = z.union([childReplySchema(resultSchema, CODES), serviceFailureSchema])

export type Request = z.infer<typeof requestSchema>
export type Result = z.infer<typeof resultSchema>
export type Reply = z.infer<typeof replySchema>

export function requestDeadlineMs(request: Request): number {
  return request.kind === 'issue' ? AWS_SPEC.domain.issueTimeoutMs : AWS_SPEC.domain.registerTimeoutMs
}

export function childDeadlineMs(request: Request): number {
  return requestDeadlineMs(request) - AWS_SPEC.domain.reserveMs
}
