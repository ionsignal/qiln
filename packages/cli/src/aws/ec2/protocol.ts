import { hasKeys, isRecord } from '../guards'
import { COMMON_CODES, replyGuard, type ChildReply } from '../child/protocol'
import { isObservation, isPlacement, type Observation, type Placement } from '../deployment/types'
import { AWS_SPEC } from '../spec'
import { isOperationId, isTimestamp } from '../types'

/** Requests name only the deployment, step, and action. Authority is reloaded from durable evidence. */
export type Request =
  | {
      kind: 'placement'
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

export type DeploymentRequest = Exclude<Request, { kind: 'placement' }>

export type Result =
  | {
      kind: 'zones'
      zones: Placement[]
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

/** Sent once by a mutating child, after its provider call returned and before its reply. */
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

/** Failures specific to this child, in addition to the common ones. */
export const FAILURES = [
  'AWS_DEPLOYMENT_NOT_ATTEMPTED',
  'AWS_DEPLOYMENT_REFUSED',
  'AWS_DEPLOYMENT_LIMIT',
  'AWS_DEPLOYMENT_BLOCKED',
  'AWS_DEPLOYMENT_VERIFICATION_FAILED',
  'AWS_DEPLOYMENT_EVIDENCE_UNAVAILABLE',
  'AWS_DEPLOYMENT_PLACEMENT_UNSUPPORTED',
] as const

export const CODES = [...COMMON_CODES, ...FAILURES] as const

export type Code = (typeof CODES)[number]

export type Reply = ChildReply<Result, Code>

export function isRequest(value: unknown): value is Request {
  if (!isRecord(value)) {
    return false
  }
  switch (value.kind) {
    case 'placement':
      return hasKeys(value, ['kind'])
    case 'mutate':
      return (
        hasKeys(value, ['kind', 'deploymentId', 'operationId']) &&
        isOperationId(value.deploymentId) &&
        isOperationId(value.operationId)
      )
    case 'observe':
      return (
        hasKeys(value, ['kind', 'deploymentId', 'wait']) &&
        isOperationId(value.deploymentId) &&
        typeof value.wait === 'boolean'
      )
    case 'candidates':
      return hasKeys(value, ['kind', 'deploymentId']) && isOperationId(value.deploymentId)
    default:
      return false
  }
}

/** Shape only. The parent validates the identity against its open step and the action's ID pattern. */
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
    case 'zones':
      return (
        hasKeys(value, ['kind', 'zones']) &&
        Array.isArray(value.zones) &&
        value.zones.length <= AWS_SPEC.deployment.maximumZones &&
        value.zones.every(isPlacement)
      )
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
    default:
      return false
  }
}

export const isReply = replyGuard(isResult, CODES)
