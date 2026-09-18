import { failureCodeFromUnknown, failureMessageFromUnknown, normalizeFailureDetails } from '../../../failures'
import { CapsuleCreatePhase } from './phases'
import type { CapsuleCreateFailureDisposition, CapsuleCreateFailureFacts } from '../policy/failure'
import type { CapsuleCreateCompensationFailure, CapsuleCreateCompensationResult } from '../types'

export interface CapsuleCreateFailureIdentity {
  operationId: string
  capsuleId: string
  rootBranchId: string | null
  rootBranchName: string | null
}

export interface CapsuleCreateFailureContextInput {
  identity: CapsuleCreateFailureIdentity
  phase: CapsuleCreatePhase
  failedPhase?: CapsuleCreatePhase
  disposition: CapsuleCreateFailureDisposition
  facts: CapsuleCreateFailureFacts
  compensation: CapsuleCreateCompensationResult | null
  contradictions: readonly string[]
}

/**
 * Keeps operation identity, selected disposition, and supporting evidence in
 * one diagnostic envelope rather than forwarding positional execution facts
 * through several terminalization helpers.
 */
export function createCapsuleCreateFailureContext(input: CapsuleCreateFailureContextInput): Record<string, unknown> {
  return {
    phase: input.phase,
    disposition: input.disposition,
    evidence: input.facts,
    ...input.identity,
    ...(input.failedPhase === undefined ? {} : { failedPhase: input.failedPhase }),
    ...(input.compensation === null ? {} : { compensation: input.compensation }),
    ...(input.contradictions.length === 0 ? {} : { contradictions: [...input.contradictions] }),
  }
}

export function createCapsuleCreateCompensationFailure(input: {
  action: string
  error: unknown
  resourceId: string
  resourceKey: string
}): CapsuleCreateCompensationFailure {
  const failure: CapsuleCreateCompensationFailure = {
    phase: CapsuleCreatePhase.COMPENSATION,
    action: input.action,
    code: failureCodeFromUnknown(input.error),
    message: failureMessageFromUnknown(input.error, 'Unknown capsule create compensation failure.'),
    resourceId: input.resourceId,
    resourceKey: input.resourceKey,
  }
  const details = normalizeFailureDetails(input.error)
  if (details !== undefined) {
    failure.details = details
  }
  return failure
}
