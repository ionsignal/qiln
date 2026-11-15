import { z } from 'zod'
import { AWS_SPEC } from '../spec'
import { rejected, uncertain } from '../child/classify'
import { markDispatched } from '../child/dispatch'
import { sign } from './proof'
import {
  certificateSchema,
  registrationSchema,
  SERVICE_CODES,
  type Code,
  type ServiceCode,
  type ServiceFailure,
} from './protocol'
import type { Credentials } from '../child/context'
import type { Failure } from '../child/protocol'

const REFUSED = rejected('DOMAIN_SERVICE_REFUSED')
const LIMITED = rejected('DOMAIN_SERVICE_LIMIT')
const BUSY = rejected('DOMAIN_SERVICE_UNAVAILABLE')

const { origin, maximumResponseBytes } = AWS_SPEC.domain

/**
 * What each service error code means for the effect. A refusal or a limit
 * leaves no DNS record or certificate changed, although an allocation row may
 * exist, which a later registration reuses. Busy and identity failures happen
 * before the registry is called. Only an upstream failure leaves the effect
 * unknown, because DNS or the CA may already have been changed.
 */
const OUTCOMES: Record<ServiceCode, Failure<Code>> = {
  bad_request: REFUSED,
  invalid_installation: REFUSED,
  invalid_address: REFUSED,
  invalid_csr: REFUSED,
  invalid_proof: REFUSED,
  principal_refused: REFUSED,
  not_found: REFUSED,
  limit_reached: LIMITED,
  rate_limited: LIMITED,
  busy: BUSY,
  identity_unavailable: BUSY,
  upstream_failure: uncertain('DOMAIN_SERVICE_UNAVAILABLE'),
}

const nonceSchema = z.object({ nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
const errorSchema = z.object({ code: z.enum(SERVICE_CODES) })

export class ServiceError extends Error {
  constructor(public readonly failure: ServiceFailure) {
    super(failure.code)
    this.name = 'ServiceError'
  }
}

function unavailable(): never {
  throw new ServiceError(uncertain('DOMAIN_SERVICE_UNAVAILABLE'))
}

function failureOf(reply: unknown): ServiceError {
  const error = errorSchema.safeParse(reply)
  return new ServiceError(
    error.success ? { ...OUTCOMES[error.data.code], service: error.data.code } : uncertain('DOMAIN_RESPONSE_INVALID'),
  )
}

/**
 * One bounded request to the pinned origin: no redirects, no proxy, and a
 * capped response body.
 */
async function exchange(
  method: string,
  path: string,
  signal: AbortSignal,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; reply: unknown }> {
  const response = await fetch(`${origin}${path}`, { method, headers, body, redirect: 'error', signal })
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength
    if (size > maximumResponseBytes) {
      throw new RangeError('The registration service response exceeds its limit.')
    }
    chunks.push(chunk)
  }
  return { status: response.status, reply: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
}

async function nonce(signal: AbortSignal): Promise<string> {
  const { status, reply } = await exchange(
    'POST',
    '/v1/nonces',
    AbortSignal.any([signal, AbortSignal.timeout(AWS_SPEC.requestTimeoutMs)]),
  ).catch(unavailable)
  const issued = nonceSchema.safeParse(reply)
  if (status !== 201 || !issued.success) {
    throw failureOf(reply)
  }
  return issued.data.nonce
}

/**
 * Dispatch is marked only after the nonce is held and the proof is signed, so
 * everything before the effect-bearing request is a definite absence of effect.
 */
async function invoke<S extends z.ZodType>(
  credentials: Credentials,
  signal: AbortSignal,
  method: string,
  path: string,
  payload: object,
  schema: S,
): Promise<z.output<S>> {
  const body = JSON.stringify(payload)
  const proof = sign(credentials, await nonce(signal), method, path, body)
  markDispatched()
  const { status, reply } = await exchange(
    method,
    path,
    signal,
    { 'Content-Type': 'application/json', 'Qiln-Proof': proof },
    body,
  ).catch(unavailable)
  if (status !== 200) {
    throw failureOf(reply)
  }
  const result = schema.safeParse(reply)
  if (!result.success) {
    throw new ServiceError(uncertain('DOMAIN_RESPONSE_INVALID'))
  }
  return result.data
}

export function register(credentials: Credentials, signal: AbortSignal, installation: string, address: string) {
  return invoke(credentials, signal, 'PUT', `/v1/installations/${installation}`, { address }, registrationSchema)
}

export function issue(credentials: Credentials, signal: AbortSignal, installation: string, csr: string) {
  return invoke(
    credentials,
    signal,
    'POST',
    `/v1/installations/${installation}/certificates`,
    { csr },
    certificateSchema,
  )
}
