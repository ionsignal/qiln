import { normalizeFailureDetails } from '../failures'
import type {
  BranchRuntimeReconciliationCandidate,
  BranchRuntimeTransitionContext,
  BranchRuntimeMutationDefinition,
  CapsuleBranchRuntimeObservation,
  UnconfirmedCapsuleBranchRuntimeObservation,
} from './types'

export const CAPSULE_BRANCH_RUNTIME_RESOLUTION_ERROR_CODE = 'CAPSULE_BRANCH_RUNTIME_UNCERTAIN'
export const CAPSULE_BRANCH_RUNTIME_INSTANCE_MISSING_ERROR_CODE = 'CAPSULE_BRANCH_RUNTIME_INSTANCE_MISSING'
export const CAPSULE_BRANCH_RUNTIME_PROVIDER_STATE_UNSUPPORTED_ERROR_CODE = 'CAPSULE_BRANCH_RUNTIME_PROVIDER_STATE_UNSUPPORTED'
export const CAPSULE_BRANCH_RUNTIME_OBSERVATION_UNAVAILABLE_ERROR_CODE = 'CAPSULE_BRANCH_RUNTIME_OBSERVATION_UNAVAILABLE'

/**
 * Durable branch-runtime diagnostic used when Qiln cannot prove one of the
 * supported stable provider states.
 *
 * This error carries persistence-safe diagnostic context only. The branch
 * service still rethrows the original provider or persistence failure to its
 * caller after recording this diagnostic best effort.
 */
export class CapsuleBranchRuntimeResolutionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'CapsuleBranchRuntimeResolutionError'
  }
}

/**
 * Converts a normalized provider observation into persistence-safe diagnostic
 * context.
 */
export function describeCapsuleBranchRuntimeObservation(observation: CapsuleBranchRuntimeObservation): Record<string, unknown> {
  switch (observation.kind) {
    case 'confirmed':
      return {
        kind: observation.kind,
        status: observation.status,
        providerStatus: observation.providerStatus,
        runtimeIp: observation.runtimeIp,
      }
    case 'missing':
      return {
        kind: observation.kind,
      }
    case 'unsupported':
      return {
        kind: observation.kind,
        providerStatus: observation.providerStatus,
      }
    case 'unavailable':
      return {
        kind: observation.kind,
        error: normalizeFailureDetails(observation.error) ?? {
          message: 'Unknown provider observation failure.',
        },
      }
  }
}

/**
 * Creates the diagnostic persisted when a start or stop mutation cannot be
 * resolved to a positively observed stable state.
 */
export function createCapsuleBranchMutationResolutionError(
  transition: BranchRuntimeTransitionContext,
  definition: BranchRuntimeMutationDefinition,
  observation: CapsuleBranchRuntimeObservation,
  mutationError: unknown,
  failureStage: string,
): CapsuleBranchRuntimeResolutionError {
  return new CapsuleBranchRuntimeResolutionError(
    `Could not prove a stable runtime state after capsule branch ${definition.mutation}.`,
    CAPSULE_BRANCH_RUNTIME_RESOLUTION_ERROR_CODE,
    {
      ownerId: transition.ownerId,
      capsuleId: transition.capsuleId,
      branchId: transition.branchId,
      branchName: transition.branchName,
      mutation: definition.mutation,
      failureStage,
      transitionalStatus: definition.transitionalStatus,
      desiredStatus: definition.desiredStatus,
      observation: describeCapsuleBranchRuntimeObservation(observation),
      mutationError: normalizeFailureDetails(mutationError) ?? {
        message: 'Unknown capsule branch runtime mutation failure.',
      },
    },
  )
}

/**
 * Creates the durable diagnostic for an unconfirmed startup-reconciliation
 * observation.
 *
 * Reconciliation policy remains in the reconciler. This helper only maps the
 * selected outcome into a stable diagnostic shape.
 */
export function createCapsuleBranchReconciliationError(
  candidate: BranchRuntimeReconciliationCandidate,
  observation: UnconfirmedCapsuleBranchRuntimeObservation,
): CapsuleBranchRuntimeResolutionError {
  const description = describeCapsuleBranchRuntimeObservation(observation)
  if (observation.kind === 'missing') {
    return new CapsuleBranchRuntimeResolutionError(
      'The managed Incus instance for this capsule branch is missing.',
      CAPSULE_BRANCH_RUNTIME_INSTANCE_MISSING_ERROR_CODE,
      {
        ownerId: candidate.ownerId,
        capsuleId: candidate.capsuleId,
        branchId: candidate.id,
        branchName: candidate.name,
        previousStatus: candidate.status,
        reconciliation: true,
        observation: description,
      },
    )
  }
  if (observation.kind === 'unsupported') {
    return new CapsuleBranchRuntimeResolutionError(
      `The managed Incus instance is in unsupported provider state '${observation.providerStatus}'.`,
      CAPSULE_BRANCH_RUNTIME_PROVIDER_STATE_UNSUPPORTED_ERROR_CODE,
      {
        ownerId: candidate.ownerId,
        capsuleId: candidate.capsuleId,
        branchId: candidate.id,
        branchName: candidate.name,
        previousStatus: candidate.status,
        reconciliation: true,
        observation: description,
      },
    )
  }
  return new CapsuleBranchRuntimeResolutionError(
    'The Worker could not observe the capsule branch provider state.',
    CAPSULE_BRANCH_RUNTIME_OBSERVATION_UNAVAILABLE_ERROR_CODE,
    {
      ownerId: candidate.ownerId,
      capsuleId: candidate.capsuleId,
      branchId: candidate.id,
      branchName: candidate.name,
      previousStatus: candidate.status,
      reconciliation: true,
      observation: description,
    },
  )
}
