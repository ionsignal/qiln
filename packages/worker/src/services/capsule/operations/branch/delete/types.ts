import type { CapsuleBranchResourceCleanupPolicy, CapsuleBranchResourceStatus, CapsuleBranchResourceType } from '@qiln/core/server'

export interface BranchDeleteSagaInput {
  ownerId: string
  name: string
  idempotencyKey: string
}

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

export interface BranchDeletePlan {
  instance: BranchDeleteInstanceTarget | null
  volumes: BranchDeleteVolumeTarget[]
  provisioningFileResourceIds: string[]
  retainedResourceIds: string[]
  externalResourceIds: string[]
}

export type BranchDeletePlanSelection = { mode: 'inventory'; plan: BranchDeletePlan } | { mode: 'live_discovery' }
