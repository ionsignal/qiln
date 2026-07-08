import type {
  CapsuleBlueprint,
  CapsuleBlueprintDigest,
  CapsuleBranchCreateOutput,
  CapsuleBranchStatus,
  CapsuleOperationCleanupPolicy,
  CapsuleOperationResourceStatus,
  CapsuleOperationResourceType,
} from '@qiln/core/server'

export interface ReconcileBranch {
  ownerId: string
  name: string
  status: CapsuleBranchStatus
}

export interface AcceptCreateOperationInput {
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

export interface AcceptedCreateOperation {
  operationId: string
  branchId: string
  replayedReceipt?: CapsuleBranchCreateOutput
}

export interface OperationResourceInput {
  operationId: string
  ownerId: string
  branchId: string
  branchName: string
  resourceType: CapsuleOperationResourceType
  resourceKey: string
  cleanupPolicy: CapsuleOperationCleanupPolicy
  status?: CapsuleOperationResourceStatus
  metadata?: Record<string, unknown>
}
