import { failureCodeFromUnknown, failureMessageFromUnknown, normalizeFailureDetails } from '../../../failures'
import { CreatePhase } from './phases'
import type { CreateCapsuleFailureDisposition, CreateCapsuleFailureFacts } from '../policy/failure'
import type { CreateCapsuleCompensationFailure, CreateCapsuleCompensationResult } from '../types'

export interface CreateCapsuleFailureIdentity {
  operationId: string
  capsuleId: string
  rootBranchId: string | null
  rootBranchName: string | null
}

export interface CreateCapsuleFailureContextInput {
  identity: CreateCapsuleFailureIdentity
  phase: CreatePhase
  failedPhase?: CreatePhase
  disposition: CreateCapsuleFailureDisposition
  facts: CreateCapsuleFailureFacts
  compensation: CreateCapsuleCompensationResult | null
  contradictions: readonly string[]
}

/**
 * Keeps operation identity, selected disposition, and supporting evidence in
 * one diagnostic envelope rather than forwarding positional execution facts
 * through several terminalization helpers.
 */
export function createCreateCapsuleFailureContext(input: CreateCapsuleFailureContextInput): Record<string, unknown> {
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

export function createCreateCapsuleCompensationFailure(input: {
  action: string
  error: unknown
  resourceId: string
  resourceKey: string
}): CreateCapsuleCompensationFailure {
  const failure: CreateCapsuleCompensationFailure = {
    phase: CreatePhase.COMPENSATION,
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
