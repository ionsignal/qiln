import type {
  CapsuleActorReference,
  CapsuleArtifactRootId,
  CapsuleBlueprintIdentifier,
  CapsuleBlueprintPin,
  CapsuleBranchName,
  CapsuleBranchResourceCleanupPolicyValue,
  CapsuleBranchResourceInventoryDigest,
  CapsuleBranchResourceStatusValue,
  CapsuleBranchResourceTypeValue,
  CapsuleBranchStatus,
  CapsuleForkReceipt,
  CapsuleLifecycleState,
  CapsuleOperationRequestHash,
  CapsuleSnapshotCapturePolicyPin,
  CapsuleSnapshotLimitationValue,
  CapsuleSnapshotModeValue,
  CapsuleRootfsImagePin,
} from '@qiln/core/server'
import type { IncusDeviceMap } from '../../../../incus/client'
import type { IncusFilePushOptions } from '../../../../incus/client/types'
import type { ProvisioningFileTarget } from '../../resource/bootstrap/targets'
import type { CapsuleOperationTransitionOutput } from '../shared'

export interface SubmitForkInput {
  ownerId: string
  actor: CapsuleActorReference
  capsuleId: string
  sourceSnapshotId: string
  branchName: CapsuleBranchName
  idempotencyKey: string
  cpu: string
  memory: string
}

export interface AcceptForkInput extends SubmitForkInput {
  requestHash: CapsuleOperationRequestHash
}

export interface ForkSnapshotResource {
  id: string
  artifactRootId: CapsuleArtifactRootId
  blueprintVolumeName: CapsuleBlueprintIdentifier
  sourceBranchResourceId: string
  captureResourceId: string
  provider: 'incus'
  kind: 'custom_volume_snapshot'
  project: string
  pool: string
  sourceVolume: string
  snapshotName: string
}

export interface ForkSource {
  snapshotId: string
  capsuleId: string
  blueprint: CapsuleBlueprintPin
  rootfsImagePin: CapsuleRootfsImagePin
  capturePolicy: CapsuleSnapshotCapturePolicyPin
  mode: CapsuleSnapshotModeValue
  limitations: CapsuleSnapshotLimitationValue[]
  resources: ForkSnapshotResource[]
}

export interface ForkPlannedResource {
  provider: 'incus'
  resourceType: CapsuleBranchResourceTypeValue
  resourceKey: string
  blueprintVolumeName: CapsuleBlueprintIdentifier | null
  cleanupPolicy: CapsuleBranchResourceCleanupPolicyValue
  metadata: Record<string, unknown>
}

export interface ForkProjectResource extends ForkPlannedResource {
  kind: 'project'
  namespace: string
}

export interface ForkBindResource extends ForkPlannedResource {
  kind: 'bind'
  deviceName: CapsuleBlueprintIdentifier
  hostPath: string
  mountPath: string
  readonly: boolean
  shifted: boolean
}

export interface ForkVolumeResource extends ForkPlannedResource {
  kind: 'volume'
  blueprintVolumeName: CapsuleBlueprintIdentifier
  deviceName: CapsuleBlueprintIdentifier
  artifactRootId: CapsuleArtifactRootId
  pool: string
  volumeName: string
  mountPath: string
  readonly: boolean
  shifted: boolean
  config: Record<string, string>
  source: {
    project: string
    pool: string
    volume: string
    snapshot: string
  }
}

export interface ForkInstanceResource extends ForkPlannedResource {
  kind: 'instance'
  instanceName: string
  rootfsImagePin: CapsuleRootfsImagePin
  config: Record<string, string>
  devices: IncusDeviceMap
}

export interface ForkFileResource extends ForkPlannedResource {
  kind: 'file'
  path: string
  content: string
  target: ProvisioningFileTarget
  restoredByClone: boolean
  options: IncusFilePushOptions
}

export interface ForkPlan {
  project: ForkProjectResource
  binds: ForkBindResource[]
  volumes: ForkVolumeResource[]
  instance: ForkInstanceResource
  files: ForkFileResource[]
  resources: ForkPlannedResource[]
  inventoryDigest: CapsuleBranchResourceInventoryDigest
}

export interface ForkBranch {
  id: string
  capsuleId: string
  name: string
  status: CapsuleBranchStatus
}

export interface ForkResourceRecord {
  id: string
  ownerId: string
  branchId: string | null
  branchName: string
  createdByOperationId: string | null
  lastOperationId: string | null
  resourceType: CapsuleBranchResourceTypeValue
  provider: string
  resourceKey: string
  blueprintVolumeName: CapsuleBlueprintIdentifier | null
  status: CapsuleBranchResourceStatusValue
  cleanupPolicy: CapsuleBranchResourceCleanupPolicyValue
  metadata: Record<string, unknown> | null
  failureCode: string | null
  failureMessage: string | null
  failureDetails: Record<string, unknown> | null
}

export const ForkResourceProofStage = {
  ACCEPTED: 'accepted',
  COMPLETED: 'completed',
} as const

export type ForkResourceProofStage = (typeof ForkResourceProofStage)[keyof typeof ForkResourceProofStage]

export interface ForkResourceProofInput {
  operationId: string
  ownerId: string
  branchId: string
  branchName: CapsuleBranchName
  extensionInventoryDigest: CapsuleBranchResourceInventoryDigest
  branchInventoryDigest: CapsuleBranchResourceInventoryDigest | null
  stage: ForkResourceProofStage
  plan: ForkPlan
  resources: readonly ForkResourceRecord[]
}

export interface ForkAcceptance {
  newlyAccepted: boolean
  receipt: CapsuleForkReceipt
  operation: CapsuleOperationTransitionOutput
  capsule: CapsuleLifecycleState
  branch: ForkBranch
}

export interface ForkExecution {
  operationId: string
  ownerId: string
  capsuleId: string
  sourceSnapshotId: string
  branchId: string
  branchName: CapsuleBranchName
  cpu: string
  memory: string
  blueprint: CapsuleBlueprintPin
  capturePolicy: CapsuleSnapshotCapturePolicyPin
  sourceMode: CapsuleSnapshotModeValue
  sourceLimitations: CapsuleSnapshotLimitationValue[]
  inventoryDigest: CapsuleBranchResourceInventoryDigest
  plan: ForkPlan
  resources: ForkResourceRecord[]
}

export interface ForkRunning {
  operation: CapsuleOperationTransitionOutput
}

export interface ForkTerminal {
  operation: CapsuleOperationTransitionOutput
  capsule: CapsuleLifecycleState
  branch: ForkBranch
}

export type ForkAbandonmentResult = ForkTerminal | null
