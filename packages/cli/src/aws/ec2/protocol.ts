import { AWS_SPEC } from '../spec'
import { hasKeys, isRecord } from '../../guards'
import { COMMON_CODES, replyGuard, type Certainty, type ChildReply } from '../child/protocol'
import { isHealth, isObservation, type Health, type Observation } from '../deployment/types'
import { isHostKey, type HostKey } from '../deployment/hostkey'
import { isDiscovery } from '../deployment/proposal/schema'
import { isIssue, type Issue } from '../deployment/proposal/failure'
import { isOperationId, isTimestamp } from '../types'
import type { Discovery } from '../deployment/proposal/types'

export type Request =
  | {
      kind: 'prepare'
    }
  | {
      kind: 'mutate'
      deploymentId: string
      operationId: string
    }
  | {
      kind: 'observe'
      deploymentId: string
      wait: boolean
    }
  | {
      kind: 'candidates'
      deploymentId: string
    }
  | {
      kind: 'health'
      deploymentId: string
      wait: boolean
    }
  | {
      kind: 'hostkey'
      deploymentId: string
    }

export type DeploymentRequest = Exclude<Request, { kind: 'prepare' }>

export type Result =
  | {
      kind: 'prepared'
      discovery: Discovery
    }
  | {
      kind: 'done'
      resourceId: string | null
    }
  | {
      kind: 'observation'
      observation: Observation
    }
  | {
      kind: 'candidates'
      candidates: Observation[]
    }
  | {
      kind: 'health'
      health: Health | null
    }
  | {
      kind: 'hostkey'
      hostKey: HostKey
    }

export interface Evidence {
  kind: 'step-returned'
  deploymentId: string
  operationId: string
  resourceId: string | null
  returnedAt: string
}

export interface Acknowledgment {
  kind: 'evidence-retained'
  deploymentId: string
  operationId: string
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

const DISCOVERY_CODE = 'AWS_DEPLOYMENT_DISCOVERY_FAILED'

export const CODES = [...COMMON_CODES, ...FAILURES] as const
export type Code = (typeof CODES)[number]

type DiscoveryCode = typeof DISCOVERY_CODE

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
export interface DiscoveryFailureReply {
  ok: false
  code: DiscoveryCode
  certainty: Certainty
  context: Issue
}

export type Reply = ChildReply<Result, Code> | DiscoveryFailureReply

export function isRequest(value: unknown): value is Request {
  if (!isRecord(value)) {
    return false
  }
  switch (value.kind) {
    case 'prepare':
      return hasKeys(value, ['kind'])
    case 'mutate':
      return (
        hasKeys(value, ['kind', 'deploymentId', 'operationId']) &&
        isOperationId(value.deploymentId) &&
        isOperationId(value.operationId)
      )
    case 'observe':
    case 'health':
      return (
        hasKeys(value, ['kind', 'deploymentId', 'wait']) &&
        isOperationId(value.deploymentId) &&
        typeof value.wait === 'boolean'
      )
    case 'candidates':
    case 'hostkey':
      return hasKeys(value, ['kind', 'deploymentId']) && isOperationId(value.deploymentId)
    default:
      return false
  }
}

export function isEvidence(value: unknown): value is Evidence {
  return (
    isRecord(value) &&
    hasKeys(value, ['kind', 'deploymentId', 'operationId', 'resourceId', 'returnedAt']) &&
    value.kind === 'step-returned' &&
    isOperationId(value.deploymentId) &&
    isOperationId(value.operationId) &&
    (value.resourceId === null || typeof value.resourceId === 'string') &&
    isTimestamp(value.returnedAt)
  )
}

export function isAcknowledgment(value: unknown, evidence: Evidence): value is Acknowledgment {
  return (
    isRecord(value) &&
    hasKeys(value, ['kind', 'deploymentId', 'operationId']) &&
    value.kind === 'evidence-retained' &&
    value.deploymentId === evidence.deploymentId &&
    value.operationId === evidence.operationId
  )
}

function isResult(value: unknown): value is Result {
  if (!isRecord(value)) {
    return false
  }
  switch (value.kind) {
    case 'prepared':
      return hasKeys(value, ['kind', 'discovery']) && isDiscovery(value.discovery)
    case 'done':
      return hasKeys(value, ['kind', 'resourceId']) && (value.resourceId === null || typeof value.resourceId === 'string')
    case 'observation':
      return hasKeys(value, ['kind', 'observation']) && isObservation(value.observation)
    case 'candidates':
      return (
        hasKeys(value, ['kind', 'candidates']) &&
        Array.isArray(value.candidates) &&
        value.candidates.every(isObservation)
      )
    case 'health':
      return hasKeys(value, ['kind', 'health']) && (value.health === null || isHealth(value.health))
    case 'hostkey':
      return hasKeys(value, ['kind', 'hostKey']) && isHostKey(value.hostKey)
    default:
      return false
  }
}

const isPlainReply = replyGuard(isResult, CODES)

function isDiscoveryFailure(value: unknown): value is DiscoveryFailureReply {
  return (
    isRecord(value) &&
    hasKeys(value, ['ok', 'code', 'certainty', 'context']) &&
    value.ok === false &&
    value.code === DISCOVERY_CODE &&
    (value.certainty === 'rejected' || value.certainty === 'uncertain') &&
    isIssue(value.context)
  )
}

export function isReply(value: unknown): value is Reply {
  return isPlainReply(value) || isDiscoveryFailure(value)
}
