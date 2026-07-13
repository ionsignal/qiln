import type {
  CapsuleBranchResourceInventoryDigest,
  CapsuleBranchResourceStatusValue,
  CapsuleBranchStatus,
  CapsuleDestroyOutput,
  CapsuleLifecycleIdempotencyKey,
} from '@qiln/core/server'
import type {
  BindMountResourceMetadata,
  InstanceResourceMetadata,
  ProjectResourceMetadata,
  ProvisioningFileResourceMetadata,
  VolumeResourceMetadata,
} from '../../resources/types'

export interface CapsuleDestroyInput {
  ownerId: string
  capsuleId: string
  idempotencyKey: CapsuleLifecycleIdempotencyKey
}

export interface CapsuleDestroyAcceptedBranch {
  id: string
  capsuleId: string
  ownerId: string
  name: string
  status: CapsuleBranchStatus
  isRootBranch: boolean
  resourceInventoryDigest: CapsuleBranchResourceInventoryDigest | null
}

export interface CapsuleDestroyContext {
  operationId: string
  ownerId: string
  capsuleId: string
  branches: readonly CapsuleDestroyAcceptedBranch[]
}

export interface CapsuleDestroyProjectResource {
  kind: 'project'
  id: string
  branchId: string
  branchName: string
  resourceKey: string
  status: CapsuleBranchResourceStatusValue
  metadata: ProjectResourceMetadata
}

export interface CapsuleDestroyBindMountResource {
  kind: 'bindMount'
  id: string
  branchId: string
  branchName: string
  resourceKey: string
  status: CapsuleBranchResourceStatusValue
  metadata: BindMountResourceMetadata
}

export interface CapsuleDestroyInstanceTarget {
  kind: 'instance'
  id: string
  branchId: string
  branchName: string
  resourceKey: string
  status: CapsuleBranchResourceStatusValue
  namespace: string
  instanceName: string
  metadata: InstanceResourceMetadata
}

export interface CapsuleDestroyVolumeTarget {
  kind: 'volume'
  id: string
  branchId: string
  branchName: string
  resourceKey: string
  status: CapsuleBranchResourceStatusValue
  namespace: string
  pool: string
  volumeName: string
  metadata: VolumeResourceMetadata
}

export interface CapsuleDestroyProvisioningFileResource {
  kind: 'provisioningFile'
  id: string
  branchId: string
  branchName: string
  resourceKey: string
  status: CapsuleBranchResourceStatusValue
  backingResourceId: string
  metadata: ProvisioningFileResourceMetadata
}

export interface CapsuleDestroyBranchPlan {
  branch: CapsuleDestroyAcceptedBranch
  project: CapsuleDestroyProjectResource
  bindMounts: CapsuleDestroyBindMountResource[]
  instance: CapsuleDestroyInstanceTarget
  volumes: CapsuleDestroyVolumeTarget[]
  provisioningFiles: CapsuleDestroyProvisioningFileResource[]
}

export interface CapsuleDestroyPlan {
  ownerId: string
  capsuleId: string
  branches: CapsuleDestroyBranchPlan[]
  instances: CapsuleDestroyInstanceTarget[]
  volumes: CapsuleDestroyVolumeTarget[]
  provisioningFiles: CapsuleDestroyProvisioningFileResource[]
  resourceIds: ReadonlySet<string>
}

export interface CapsuleDestroyPlanSummary {
  branchCount: number
  instanceCount: number
  volumeCount: number
  provisioningFileCount: number
}

export type CapsuleDestroyResult = CapsuleDestroyOutput
