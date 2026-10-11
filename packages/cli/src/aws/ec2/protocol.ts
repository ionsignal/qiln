import { hasKeys, isRecord } from '../guards'
import { COMMON_CODES, replyGuard, type ChildReply } from '../child/protocol'
import { isObservation, isVpcId, type Observation } from '../deployment/types'
import { isOperationId, isTimestamp } from '../types'

export const UNTIL = ['any', 'available', 'absent'] as const

export type Until = (typeof UNTIL)[number]

/** Requests name only the deployment, operation, and action. Authority is reloaded from durable evidence. */
export type Request =
  | {
      kind: 'create' | 'delete'
      deploymentId: string
      operationId: string
    }
  | {
      kind: 'observe'
      deploymentId: string
      until: Until
    }
  | {
      kind: 'candidates'
      deploymentId: string
    }

export type Result =
  | {
      kind: 'created'
      vpcId: string
    }
  | {
      kind: 'deleted'
    }
  | {
      kind: 'observation'
      observation: Observation
    }
  | {
      kind: 'candidates'
      candidates: Observation[]
    }

/** Sent once by a mutating child, after its provider call returned and before its reply. */
export type Evidence =
  | {
      kind: 'vpc-created'
      deploymentId: string
      operationId: string
      vpcId: string
      returnedAt: string
    }
  | {
      kind: 'vpc-deleted'
      deploymentId: string
      operationId: string
      returnedAt: string
    }

export interface Acknowledgment {
  kind: 'evidence-retained'
  deploymentId: string
  operationId: string
}

/** Failures specific to this child, in addition to the common ones. */
export const FAILURES = [
  'AWS_DEPLOYMENT_NOT_ATTEMPTED',
  'AWS_DEPLOYMENT_REFUSED',
  'AWS_DEPLOYMENT_LIMIT',
  'AWS_DEPLOYMENT_BLOCKED',
  'AWS_DEPLOYMENT_VERIFICATION_FAILED',
  'AWS_DEPLOYMENT_EVIDENCE_UNAVAILABLE',
] as const

export const CODES = [...COMMON_CODES, ...FAILURES] as const

export type Code = (typeof CODES)[number]

export type Reply = ChildReply<Result, Code>

export function isRequest(value: unknown): value is Request {
  if (!isRecord(value) || !isOperationId(value.deploymentId)) {
    return false
  }
  switch (value.kind) {
    case 'create':
    case 'delete':
      return hasKeys(value, ['kind', 'deploymentId', 'operationId']) && isOperationId(value.operationId)
    case 'observe':
      return hasKeys(value, ['kind', 'deploymentId', 'until']) && UNTIL.some(until => until === value.until)
    case 'candidates':
      return hasKeys(value, ['kind', 'deploymentId'])
    default:
      return false
  }
}

export function isEvidence(value: unknown): value is Evidence {
  if (!isRecord(value) || !isOperationId(value.deploymentId) || !isOperationId(value.operationId)) {
    return false
  }
  switch (value.kind) {
    case 'vpc-created':
      return (
        hasKeys(value, ['kind', 'deploymentId', 'operationId', 'vpcId', 'returnedAt']) &&
        isVpcId(value.vpcId) &&
        isTimestamp(value.returnedAt)
      )
    case 'vpc-deleted':
      return hasKeys(value, ['kind', 'deploymentId', 'operationId', 'returnedAt']) && isTimestamp(value.returnedAt)
    default:
      return false
  }
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
    case 'created':
      return hasKeys(value, ['kind', 'vpcId']) && isVpcId(value.vpcId)
    case 'deleted':
      return hasKeys(value, ['kind'])
    case 'observation':
      return hasKeys(value, ['kind', 'observation']) && isObservation(value.observation)
    case 'candidates':
      return (
        hasKeys(value, ['kind', 'candidates']) &&
        Array.isArray(value.candidates) &&
        value.candidates.every(isObservation)
      )
    default:
      return false
  }
}

export const isReply = replyGuard(isResult, CODES)
