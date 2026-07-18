import type {
  CapsuleBranchResourceInventoryDigest,
  CapsuleBranchResourceStatusValue,
  CapsuleBranchStatus,
  CapsuleDestroyReceipt,
  CapsuleLifecycleState,
  CapsuleOperationRequestHash,
} from '@qiln/core/server'
import type {
  BindMountResourceMetadata,
  InstanceResourceMetadata,
  ProjectResourceMetadata,
  ProvisioningFileResourceMetadata,
  VolumeResourceMetadata,
} from '../../resource/types'
import type { CapsuleOperationTransitionOutput } from '../shared'

export interface SubmitDestroyCapsuleInput {
  ownerId: string
  capsuleId: string
  idempotencyKey: string
}

export interface AcceptDestroyCapsuleOperationInput extends SubmitDestroyCapsuleInput {
  requestHash: CapsuleOperationRequestHash
}

export interface DestroyCapsuleAcceptedBranch {
  id: string
  capsuleId: string
  ownerId: string
  name: string
  status: CapsuleBranchStatus
  isRootBranch: boolean
  resourceInventoryDigest: CapsuleBranchResourceInventoryDigest | null
}

export interface DestroyCapsuleCommittedBranch {
  id: string
  capsuleId: string
  name: string
  status: CapsuleBranchStatus
}

export interface DestroyCapsuleRepositoryResult {
  newlyAccepted: boolean
  receipt: CapsuleDestroyReceipt
  operation: CapsuleOperationTransitionOutput
  capsule: CapsuleLifecycleState
  branches: DestroyCapsuleCommittedBranch[]
}

export interface DestroyCapsuleTerminalResult {
  operation: CapsuleOperationTransitionOutput
  capsule: CapsuleLifecycleState
  branches: DestroyCapsuleCommittedBranch[]
}

export type DestroyCapsuleAbandonedClassificationResult = DestroyCapsuleTerminalResult | null

export interface DestroyCapsuleExecutionInput {
  operationId: string
  ownerId: string
  capsuleId: string
  branches: readonly DestroyCapsuleAcceptedBranch[]
}

export interface DestroyCapsuleOperationContext {
  readonly operationId: string
  readonly ownerId: string
  readonly capsuleId: string
  readonly branches: readonly DestroyCapsuleAcceptedBranch[]
}

export interface DestroyCapsuleProjectResource {
  kind: 'project'
  id: string
  branchId: string
  branchName: string
  resourceKey: string
  status: CapsuleBranchResourceStatusValue
  metadata: ProjectResourceMetadata
}

export interface DestroyCapsuleBindMountResource {
  kind: 'bindMount'
  id: string
  branchId: string
  branchName: string
  resourceKey: string
  status: CapsuleBranchResourceStatusValue
  metadata: BindMountResourceMetadata
}

export interface DestroyCapsuleInstanceTarget {
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

export interface DestroyCapsuleVolumeTarget {
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

export interface DestroyCapsuleProvisioningFileResource {
  kind: 'provisioningFile'
  id: string
  branchId: string
  branchName: string
  resourceKey: string
  status: CapsuleBranchResourceStatusValue
  backingResourceId: string
  metadata: ProvisioningFileResourceMetadata
}

export interface DestroyCapsuleBranchPlan {
  branch: DestroyCapsuleAcceptedBranch
  project: DestroyCapsuleProjectResource
  bindMounts: DestroyCapsuleBindMountResource[]
  instance: DestroyCapsuleInstanceTarget
  volumes: DestroyCapsuleVolumeTarget[]
  provisioningFiles: DestroyCapsuleProvisioningFileResource[]
}

export interface DestroyCapsulePlan {
  ownerId: string
  capsuleId: string
  branches: DestroyCapsuleBranchPlan[]
  instances: DestroyCapsuleInstanceTarget[]
  volumes: DestroyCapsuleVolumeTarget[]
  provisioningFiles: DestroyCapsuleProvisioningFileResource[]
  resourceIds: ReadonlySet<string>
}

export interface DestroyCapsulePlanSummary {
  branchCount: number
  instanceCount: number
  volumeCount: number
  provisioningFileCount: number
}
