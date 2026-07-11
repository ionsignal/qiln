import type {
  CapsuleBranchResourceCleanupPolicyValue,
  CapsuleBranchResourceStatusValue,
  CapsuleBranchResourceTypeValue,
} from '@qiln/core/server'

export interface BranchDeleteOperationInput {
  ownerId: string
  name: string
  idempotencyKey: string
}

export interface BranchDeleteResourceRow {
  id: string
  provider: string
  resourceType: CapsuleBranchResourceTypeValue
  resourceKey: string
  status: CapsuleBranchResourceStatusValue
  cleanupPolicy: CapsuleBranchResourceCleanupPolicyValue
  metadata: Record<string, unknown> | null
}

export interface BranchDeletePlanInput {
  branchName: string
  namespace: string
  resources: readonly BranchDeleteResourceRow[]
}

export interface BranchDeleteInstanceTarget {
  resourceId: string
  instanceName: string
}

export interface BranchDeleteVolumeTarget {
  resourceId: string
  pool: string
  volumeName: string
}

export interface BranchDeletePlan {
  instance: BranchDeleteInstanceTarget | null
  volumes: BranchDeleteVolumeTarget[]
  provisioningFileResourceIdsToFinalize: string[]
}
