import type {
  CapsuleActorReference,
  CapsuleBlueprintDigest,
  CapsuleBlueprintPin,
  CapsuleBranchStatus,
  CapsuleCreateReceipt,
  CapsuleLifecycleState,
  CapsuleRootfsImagePin,
  CapsuleOperationRequestHash,
} from '@qiln/core/server'
import type { CapsuleOperationTransitionOutput } from '../shared'
import type { CapsuleCreatePhase } from './execution/phases'

export interface CapsuleCreateSubmissionInput {
  ownerId: string
  actor: CapsuleActorReference
  rootBranchName: string
  idempotencyKey: string
  blueprintName: string
  blueprintDigest: CapsuleBlueprintDigest
  cpu: string
  memory: string
}

export interface CapsuleCreateAcceptanceInput extends CapsuleCreateSubmissionInput {
  requestHash: CapsuleOperationRequestHash
  blueprintPin: CapsuleBlueprintPin
  rootfsImagePin: CapsuleRootfsImagePin
}

export interface CapsuleCreateAcceptanceResult {
  newlyAccepted: boolean
  receipt: CapsuleCreateReceipt
  operation: CapsuleOperationTransitionOutput
  capsule: CapsuleLifecycleState
  branch: CapsuleCreateBranchState
}

export interface CapsuleCreateBranchState {
  id: string
  capsuleId: string
  name: string
  status: CapsuleBranchStatus
}

export interface CapsuleCreateTerminalResult {
  operation: CapsuleOperationTransitionOutput
  capsule: CapsuleLifecycleState
  branch: CapsuleCreateBranchState | null
}

export interface CapsuleCreateExecutionInput {
  operationId: string
  capsuleId: string
  ownerId: string
  rootBranchId: string
  rootBranchName: string
  blueprintPin: CapsuleBlueprintPin
  rootfsImagePin: CapsuleRootfsImagePin
  cpu: string
  memory: string
}

export interface CapsuleCreateOperationContext {
  readonly operationId: string
  readonly capsuleId: string
  readonly ownerId: string
  readonly rootBranchId: string
  readonly rootBranchName: string
  readonly namespace: string
}

export interface CapsuleCreateCompensationFailure {
  phase: typeof CapsuleCreatePhase.COMPENSATION
  action: string
  code: string
  message: string
  resourceId: string
  resourceKey: string
  details?: Record<string, unknown>
}

export interface CapsuleCreateCompensationResult {
  fullyCompensated: boolean
  failures: CapsuleCreateCompensationFailure[]
}

export interface CapsuleCreateFailureInput {
  operationId: string
  error: unknown
  phase: CapsuleCreatePhase
  providerIntentConfirmed: boolean
  providerOwnershipUncertain: boolean
  completionAttempted: boolean
  compensation: CapsuleCreateCompensationResult | null
}
