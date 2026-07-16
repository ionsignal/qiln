/**
 * Stable Qiln runtime statuses that correspond to positively observed Incus
 * instance states.
 */
export type StableBranchRuntimeStatus = 'online' | 'offline'

/**
 * Durable mutation fences written before a branch runtime provider mutation.
 */
export type TransitionalBranchRuntimeStatus = 'starting' | 'stopping'
export type BranchRuntimeMutation = 'start' | 'stop'

/**
 * Explicit policy for one branch runtime mutation.
 *
 * The desired and opposite statuses are used when resolving a provider error
 * through a single follow-up provider observation.
 */
export interface BranchRuntimeMutationDefinition {
  mutation: BranchRuntimeMutation
  transitionalStatus: TransitionalBranchRuntimeStatus
  desiredStatus: StableBranchRuntimeStatus
  oppositeStatus: StableBranchRuntimeStatus
}

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
 * reconciliation, and mutation resolution operate only on these outcomes.
 */
export type CapsuleBranchRuntimeObservation =
  | ConfirmedCapsuleBranchRuntimeState
  | MissingCapsuleBranchRuntimeState
  | UnsupportedCapsuleBranchRuntimeState
  | UnavailableCapsuleBranchRuntimeState
export type UnconfirmedCapsuleBranchRuntimeObservation = Exclude<CapsuleBranchRuntimeObservation, { kind: 'confirmed' }>
