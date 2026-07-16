import type {
  CapsuleBranchResourceCleanupPolicyValue,
  CapsuleBranchResourceInventoryDigest,
  CapsuleBranchResourceStatusValue,
  CapsuleBranchResourceTypeValue,
  CapsuleBranchStatus,
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

/**
 * Shared resource-level persistence input.
 *
 * Operation-specific repositories own operation acceptance and aggregate
 * transitions. This shape carries only the provenance required to associate a
 * branch resource with the operation that created it.
 */
export interface BranchResourceInput {
  operationId: string
  ownerId: string
  branchId: string
  branchName: string
  resourceType: CapsuleBranchResourceTypeValue
  resourceKey: string
  cleanupPolicy: CapsuleBranchResourceCleanupPolicyValue
  provider?: string
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
  createdByOperationId: string | null
  lastOperationId: string | null
}

/**
 * Branch identity required by destroy planning and operation-specific
 * repositories.
 */
export interface CapsuleBranchIdentityRow {
  id: string
  capsuleId: string
  ownerId: string
  name: string
  status: CapsuleBranchStatus
  isRootBranch: boolean
  resourceInventoryDigest: CapsuleBranchResourceInventoryDigest | null
}
