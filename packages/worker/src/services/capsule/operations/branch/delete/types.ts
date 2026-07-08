import type { CapsuleBranchResourceCleanupPolicy, CapsuleBranchResourceStatus, CapsuleBranchResourceType } from '@qiln/core/server'

export interface BranchDeleteResourceRow {
  id: string
  resourceType: CapsuleBranchResourceType
  resourceKey: string
  status: CapsuleBranchResourceStatus
  cleanupPolicy: CapsuleBranchResourceCleanupPolicy
  metadata: Record<string, unknown> | null
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

export interface BranchDeleteCleanupPlan {
  instance: BranchDeleteInstanceTarget | null
  volumes: BranchDeleteVolumeTarget[]
  provisioningFileResourceIds: string[]
  retainedResourceIds: string[]
  externalResourceIds: string[]
}
