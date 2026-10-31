import { z } from 'zod'
import { AWS_SPEC } from '../spec'
import { certaintySchema, childReplySchema, COMMON_CODES } from '../child/protocol'
import { operationId, timestamp } from '../../journal/step'
import { hostKeySchema } from '../deployment/ssh/hostkey'
import { discoverySchema } from '../deployment/proposal/validate'
import { issueSchema } from '../deployment/proposal/failure'
import { healthSchema, observationSchema, observationsSchema } from '../deployment/types'

export const requestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('prepare') }),
  z.strictObject({ kind: z.literal('mutate'), deploymentId: operationId, operationId }),
  z.strictObject({ kind: z.literal('observe'), deploymentId: operationId, wait: z.boolean() }),
  z.strictObject({ kind: z.literal('candidates'), deploymentId: operationId }),
  z.strictObject({ kind: z.literal('health'), deploymentId: operationId, wait: z.boolean() }),
  z.strictObject({ kind: z.literal('hostkey'), deploymentId: operationId }),
])

export type Request = z.infer<typeof requestSchema>

export type DeploymentRequest = Exclude<Request, { kind: 'prepare' }>

const resultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('prepared'), discovery: discoverySchema }),
  z.strictObject({ kind: z.literal('done'), resourceId: z.string().nullable() }),
  z.strictObject({ kind: z.literal('observation'), observation: observationSchema }),
  z.strictObject({ kind: z.literal('candidates'), candidates: observationsSchema }),
  z.strictObject({ kind: z.literal('health'), health: healthSchema.nullable() }),
  z.strictObject({ kind: z.literal('hostkey'), hostKey: hostKeySchema }),
])

export type Result = z.infer<typeof resultSchema>

export const evidenceSchema = z.strictObject({
  kind: z.literal('step-returned'),
  deploymentId: operationId,
  operationId,
  resourceId: z.string().nullable(),
  returnedAt: timestamp,
})

export type Evidence = z.infer<typeof evidenceSchema>

const acknowledgmentSchema = z.strictObject({
  kind: z.literal('evidence-retained'),
  deploymentId: operationId,
  operationId,
})

export type Acknowledgment = z.infer<typeof acknowledgmentSchema>

/**
 * The child continues only when the parent acknowledges this exact evidence.
 */
export function acknowledgmentFor(evidence: Evidence) {
  return acknowledgmentSchema.refine(
    acknowledgment =>
      acknowledgment.deploymentId === evidence.deploymentId && acknowledgment.operationId === evidence.operationId,
  )
}

export const FAILURES = [
  'AWS_DEPLOYMENT_NOT_ATTEMPTED',
  'AWS_DEPLOYMENT_REFUSED',
  'AWS_DEPLOYMENT_LIMIT',
  'AWS_DEPLOYMENT_CAPACITY',
  'AWS_DEPLOYMENT_BLOCKED',
  'AWS_DEPLOYMENT_VERIFICATION_FAILED',
  'AWS_DEPLOYMENT_HEALTH_UNVERIFIED',
  'AWS_DEPLOYMENT_HOST_KEY_UNVERIFIED',
  'AWS_DEPLOYMENT_EVIDENCE_UNAVAILABLE',
  'AWS_DEPLOYMENT_DISCOVERY_FAILED',
  'AWS_DEPLOYMENT_IMAGE_UNAVAILABLE',
] as const

export const CODES = [...COMMON_CODES, ...FAILURES] as const
export type Code = (typeof CODES)[number]

/**
 * The parent's supervision deadline for one request. Only a polling health
 * wait and a host-key read need more than the ordinary budget.
 */
export function requestDeadlineMs(request: Request): number {
  if (request.kind === 'hostkey') {
    return AWS_SPEC.deployment.hostKey.requestTimeoutMs
  }
  return request.kind === 'health' && request.wait
    ? AWS_SPEC.deployment.health.requestTimeoutMs
    : AWS_SPEC.deployment.requestTimeoutMs
}

/**
 * The child's own abort deadline. It ends earlier than the parent's, so the
 * child can classify its failure and transmit it first.
 */
export function childDeadlineMs(request: Request): number {
  return requestDeadlineMs(request) - AWS_SPEC.deployment.reserveMs
}

/**
 * A discovery failure may also carry the first field of evidence that failed
 * validation. The shared envelope accepts the ordinary form of every code,
 * including this one, so this contextual shape is an addition, not a gate.
 */
const discoveryFailureSchema = z.strictObject({
  ok: z.literal(false),
  code: z.literal('AWS_DEPLOYMENT_DISCOVERY_FAILED'),
  certainty: certaintySchema,
  context: issueSchema,
})

export const replySchema = z.union([childReplySchema(resultSchema, CODES), discoveryFailureSchema])

export type Reply = z.infer<typeof replySchema>
