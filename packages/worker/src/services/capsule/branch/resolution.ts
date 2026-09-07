import { normalizeFailureDetails } from '../failures'
import type {
  BranchRuntimeReconciliationCandidate,
  CapsuleBranchRuntimeObservation,
  UnconfirmedCapsuleBranchRuntimeObservation,
} from './types'

export const CAPSULE_BRANCH_RUNTIME_INSTANCE_MISSING_ERROR_CODE = 'CAPSULE_BRANCH_RUNTIME_INSTANCE_MISSING'
export const CAPSULE_BRANCH_RUNTIME_PROVIDER_STATE_UNSUPPORTED_ERROR_CODE =
  'CAPSULE_BRANCH_RUNTIME_PROVIDER_STATE_UNSUPPORTED'
export const CAPSULE_BRANCH_RUNTIME_OBSERVATION_UNAVAILABLE_ERROR_CODE =
  'CAPSULE_BRANCH_RUNTIME_OBSERVATION_UNAVAILABLE'

/**
 * Durable branch-runtime diagnostic used when Qiln cannot prove one of the
 * supported stable provider states.
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
export function describeCapsuleBranchRuntimeObservation(
  observation: CapsuleBranchRuntimeObservation,
): Record<string, unknown> {
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
