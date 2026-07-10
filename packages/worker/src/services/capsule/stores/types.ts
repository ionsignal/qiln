import type {
  CapsuleBlueprint,
  CapsuleBlueprintDigest,
  CapsuleBranchCreateOutput,
  CapsuleBranchDeleteOutput,
  CapsuleBranchOperationStatusValue,
  CapsuleBranchOperationStepStatusValue,
  CapsuleBranchResourceCleanupPolicyValue,
  CapsuleBranchResourceInventoryDigest,
  CapsuleBranchResourceStatusValue,
  CapsuleBranchResourceTypeValue,
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

export interface AcceptBranchDeleteOperationInput {
  ownerId: string
  name: string
  idempotencyKey: string
  requestHash: string
}

export interface AcceptedBranchDeleteOperation {
  operationId: string
  branchId: string
  resourceInventoryDigest: CapsuleBranchResourceInventoryDigest | null
  replayedReceipt?: CapsuleBranchDeleteOutput
}

export interface AbandonedBranchCreateOperationCandidate {
  id: string
  ownerId: string
  branchId: string | null
  branchName: string
  status: CapsuleBranchOperationStatusValue
  createdAt: Date
  updatedAt: Date
}

export interface AbandonedBranchDeleteOperationCandidate {
  id: string
  ownerId: string
  branchId: string | null
  branchName: string
  status: CapsuleBranchOperationStatusValue
  createdAt: Date
  updatedAt: Date
}

export interface BranchResourceInput {
  operationId: string
  ownerId: string
  branchId: string
  branchName: string
  resourceType: CapsuleBranchResourceTypeValue
  resourceKey: string
  cleanupPolicy: CapsuleBranchResourceCleanupPolicyValue
  status?: CapsuleBranchResourceStatusValue
  metadata?: Record<string, unknown>
}

export interface BranchOperationStepInput {
  operationId: string
  ownerId: string
  branchId?: string | null
  branchName: string
  stepKey: string
  status?: CapsuleBranchOperationStepStatusValue
  metadata?: Record<string, unknown>
}

export type BranchOperationStatusValue = CapsuleBranchOperationStatusValue
export type BranchOperationStepStatusValue = CapsuleBranchOperationStepStatusValue
export type CompensationCallback = () => Promise<void>
