import type {
  CapsuleActorReference,
  CapsuleBlueprint,
  CapsuleBlueprintDigest,
  CapsuleBranchStatus,
  CapsuleCreateReceipt,
  CapsuleLifecycleState,
  CapsuleRootfsImagePin,
  CapsuleOperationRequestHash,
} from '@qiln/core/server'
import type { CapsuleOperationTransitionOutput } from '../shared'
import type { CreatePhase } from './execution/phases'

export interface SubmitCreateCapsuleInput {
  ownerId: string
  actor: CapsuleActorReference
  rootBranchName: string
  idempotencyKey: string
  blueprintName: string
  blueprintDigest: CapsuleBlueprintDigest
  cpu: string
  memory: string
}

export interface AcceptCreateCapsuleOperationInput extends SubmitCreateCapsuleInput {
  requestHash: CapsuleOperationRequestHash
  blueprintSnapshot: CapsuleBlueprint
  rootfsImagePin: CapsuleRootfsImagePin
}

export interface CreateCapsuleRepositoryResult {
  newlyAccepted: boolean
  receipt: CapsuleCreateReceipt
  operation: CapsuleOperationTransitionOutput
  capsule: CapsuleLifecycleState
  branch: CreateCapsuleCommittedBranch
}

export interface CreateCapsuleCommittedBranch {
  id: string
  capsuleId: string
  name: string
  status: CapsuleBranchStatus
}

export interface CreateCapsuleTerminalResult {
  operation: CapsuleOperationTransitionOutput
  capsule: CapsuleLifecycleState
  branch: CreateCapsuleCommittedBranch | null
}

export interface CreateCapsuleExecutionInput {
  operationId: string
  capsuleId: string
  ownerId: string
  rootBranchId: string
  rootBranchName: string
  blueprintName: string
  blueprintDigest: CapsuleBlueprintDigest
  blueprintSnapshot: CapsuleBlueprint
  rootfsImagePin: CapsuleRootfsImagePin
  cpu: string
  memory: string
}

export interface CreateCapsuleOperationContext {
  readonly operationId: string
  readonly capsuleId: string
  readonly ownerId: string
  readonly rootBranchId: string
  readonly rootBranchName: string
  readonly namespace: string
}

export interface CreateCapsuleCompensationFailure {
  phase: typeof CreatePhase.COMPENSATION
  action: string
  code: string
  message: string
  resourceId: string
  resourceKey: string
  details?: Record<string, unknown>
}

export interface CreateCapsuleCompensationResult {
  fullyCompensated: boolean
  failures: CreateCapsuleCompensationFailure[]
}

export interface CreateCapsuleFailureInput {
  operationId: string
  error: unknown
  phase: CreatePhase
  providerIntentConfirmed: boolean
  providerOwnershipUncertain: boolean
  completionAttempted: boolean
  compensation: CreateCapsuleCompensationResult | null
}
