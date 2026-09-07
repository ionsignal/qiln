import type { CapsuleBranchStatus } from '@qiln/core/server'

/**
 * Stable Qiln runtime statuses that correspond to positively observed Incus
 * instance states.
 */
export type StableBranchRuntimeStatus = 'online' | 'offline'

export type ConfirmedCapsuleBranchRuntimeState =
  | {
      kind: 'confirmed'
      status: 'online'
      runtimeIp: string | null
      providerStatus: 'Running'
    }
  | {
      kind: 'confirmed'
      status: 'offline'
      runtimeIp: null
      providerStatus: 'Stopped'
    }

export interface MissingCapsuleBranchRuntimeState {
  kind: 'missing'
}

export interface UnsupportedCapsuleBranchRuntimeState {
  kind: 'unsupported'
  providerStatus: string
}

export interface UnavailableCapsuleBranchRuntimeState {
  kind: 'unavailable'
  error: unknown
}

/**
 * Normalized provider-observation vocabulary consumed by branch runtime policy.
 *
 * Provider-specific state interpretation belongs to the observer. Persistence,
 * reconciliation, and operation execution operate only on these outcomes.
 */
export type CapsuleBranchRuntimeObservation =
  | ConfirmedCapsuleBranchRuntimeState
  | MissingCapsuleBranchRuntimeState
  | UnsupportedCapsuleBranchRuntimeState
  | UnavailableCapsuleBranchRuntimeState

export type UnconfirmedCapsuleBranchRuntimeObservation = Exclude<CapsuleBranchRuntimeObservation, { kind: 'confirmed' }>

/**
 * Durable branch identity selected for observation-only startup reconciliation.
 */
export interface BranchRuntimeReconciliationCandidate {
  id: string
  capsuleId: string
  ownerId: string
  name: string
  status: CapsuleBranchStatus
}

export interface ConfirmedBranchRuntimeStateInput {
  ownerId: string
  capsuleId: string
  branchId: string
  expectedStatus: CapsuleBranchStatus
  confirmedStatus: 'online' | 'offline'
  runtimeIp: string | null
}

export interface ConfirmedBranchRuntimeStateResult {
  branchName: string
  previousStatus: CapsuleBranchStatus
  status: 'online' | 'offline'
  statusChanged: boolean
}

export interface BranchRuntimeErrorInput {
  ownerId: string
  capsuleId: string
  branchId: string
  expectedStatus: CapsuleBranchStatus
  error: unknown
  context: Record<string, unknown>
}

export interface BranchRuntimeErrorResult {
  branchName: string
  previousStatus: CapsuleBranchStatus
  status: 'error'
  statusChanged: boolean
}
