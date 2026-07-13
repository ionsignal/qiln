import type {
  CapsuleBlueprint,
  CapsuleBlueprintDigest,
  CapsuleBootstrapCreateOutput,
  CapsuleBranchResourceCleanupPolicyValue,
  CapsuleBranchResourceInventoryDigest,
  CapsuleBranchResourceStatusValue,
  CapsuleBranchResourceTypeValue,
  CapsuleBranchStatus,
  CapsuleLifecycleOperationStatusValue,
  CapsuleLifecycleOperationStepStatusValue,
  CapsuleLifecycleStatusValue,
} from '@qiln/core/server'

export interface BranchRuntimeReconciliationCandidate {
  id: string
  capsuleId: string
  ownerId: string
  name: string
  status: CapsuleBranchStatus
}

export interface BranchRuntimeTransitionContext {
  ownerId: string
  branchId: string
  capsuleId: string
  branchName: string
  previousStatus: 'offline' | 'online'
  transitionalStatus: 'starting' | 'stopping'
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

export interface AcceptBootstrapLifecycleOperationInput {
  ownerId: string
  bootstrapBranchName: string
  idempotencyKey: string
  requestHash: string
  blueprintName: string
  blueprintDigest: CapsuleBlueprintDigest
  blueprintSnapshot: CapsuleBlueprint
  cpu: string
  memory: string
}

export type AcceptedBootstrapLifecycleOperation =
  | {
      operationId: string
      capsuleId: string
      branchId: string
    }
  | {
      replayedReceipt: CapsuleBootstrapCreateOutput
    }

export interface ArchiveCapsuleInput {
  ownerId: string
  capsuleId: string
  idempotencyKey: string
  requestHash: string
}

export interface UnarchiveCapsuleInput {
  ownerId: string
  capsuleId: string
  idempotencyKey: string
  requestHash: string
}

export interface AcceptDestroyLifecycleOperationInput {
  ownerId: string
  capsuleId: string
  idempotencyKey: string
  requestHash: string
}

export type AcceptedDestroyLifecycleOperation =
  | {
      operationId: string
      capsuleId: string
      branches: DestroyingCapsuleBranch[]
    }
  | {
      replayedReceipt: CapsuleLifecycleReceiptRecord
    }

export interface DestroyingCapsuleBranch {
  id: string
  capsuleId: string
  ownerId: string
  name: string
  status: CapsuleBranchStatus
  isRootBranch: boolean
  resourceInventoryDigest: CapsuleBranchResourceInventoryDigest | null
}

export interface CapsuleLifecycleReceiptRecord {
  operationId: string
  operationType: 'archive' | 'unarchive' | 'destroy'
  operationStatus: CapsuleLifecycleOperationStatusValue
  capsuleId: string
  lifecycleStatus: CapsuleLifecycleStatusValue
  archivedAt: Date | null
  destroyedAt: Date | null
  replayed: boolean
}

export interface AbandonedBootstrapLifecycleOperationCandidate {
  id: string
  capsuleId: string
  ownerId: string
  branchId: string | null
  branchName: string | null
  status: CapsuleLifecycleOperationStatusValue
  createdAt: Date
  updatedAt: Date
}

export interface AbandonedDestroyLifecycleOperationCandidate {
  id: string
  capsuleId: string
  ownerId: string
  status: CapsuleLifecycleOperationStatusValue
  createdAt: Date
  updatedAt: Date
}

export interface BranchResourceInput {
  lifecycleOperationId: string
  ownerId: string
  branchId: string
  branchName: string
  resourceType: CapsuleBranchResourceTypeValue
  resourceKey: string
  cleanupPolicy: CapsuleBranchResourceCleanupPolicyValue
  metadata?: Record<string, unknown>
}

export interface LifecycleOperationStepInput {
  operationId: string
  capsuleId: string
  ownerId: string
  branchId?: string | null
  branchName?: string | null
  stepKey: string
  status?: CapsuleLifecycleOperationStepStatusValue
  metadata?: Record<string, unknown>
}

export interface CapsuleBranchResourceInventoryRow {
  id: string
  ownerId: string
  branchId: string | null
  branchName: string
  provider: string
  resourceType: CapsuleBranchResourceTypeValue
  resourceKey: string
  status: CapsuleBranchResourceStatusValue
  cleanupPolicy: CapsuleBranchResourceCleanupPolicyValue
  metadata: Record<string, unknown> | null
  createdByLifecycleOperationId: string | null
  lastLifecycleOperationId: string | null
}

export type LifecycleOperationStatusValue = CapsuleLifecycleOperationStatusValue
export type LifecycleOperationStepStatusValue = CapsuleLifecycleOperationStepStatusValue
