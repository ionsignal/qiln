import type {
  CapsuleBlueprint,
  CapsuleBlueprintDigest,
  CapsuleBranchCreateOutput,
  CapsuleBranchOperationStatus,
  CapsuleBranchOperationStepStatus,
  CapsuleBranchResourceCleanupPolicy,
  CapsuleBranchResourceStatus,
  CapsuleBranchResourceType,
  CapsuleBranchStatus,
} from '@qiln/core/server'

export interface ReconcileBranch {
  ownerId: string
  name: string
  status: CapsuleBranchStatus
}

export interface AcceptBranchCreateOperationInput {
  ownerId: string
  name: string
  idempotencyKey: string
  requestHash: string
  blueprintName: string
  blueprintDigest: CapsuleBlueprintDigest
  blueprintSnapshot: CapsuleBlueprint
  cpu: string
  memory: string
}

export interface AcceptedBranchCreateOperation {
  operationId: string
  branchId: string
  replayedReceipt?: CapsuleBranchCreateOutput
}

export interface AbandonedBranchCreateOperationCandidate {
  id: string
  ownerId: string
  branchId: string | null
  branchName: string
  status: CapsuleBranchOperationStatus
  createdAt: Date
  updatedAt: Date
}

export interface BranchResourceInput {
  operationId: string
  ownerId: string
  branchId: string
  branchName: string
  resourceType: CapsuleBranchResourceType
  resourceKey: string
  cleanupPolicy: CapsuleBranchResourceCleanupPolicy
  status?: CapsuleBranchResourceStatus
  metadata?: Record<string, unknown>
}

export interface BranchOperationStepInput {
  operationId: string
  ownerId: string
  branchId?: string | null
  branchName: string
  stepKey: string
  status?: CapsuleBranchOperationStepStatus
  metadata?: Record<string, unknown>
}

export type BranchOperationStatusValue = CapsuleBranchOperationStatus
export type BranchOperationStepStatusValue = CapsuleBranchOperationStepStatus
export type CompensationCallback = () => Promise<void>
