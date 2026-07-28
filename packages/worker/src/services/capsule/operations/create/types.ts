import type {
  CapsuleActorReference,
  CapsuleBlueprint,
  CapsuleBlueprintDigest,
  CapsuleBlueprintIdentifier,
  CapsuleBranchResourceCleanupPolicyValue,
  CapsuleBranchResourceTypeValue,
  CapsuleBranchStatus,
  CapsuleCreateReceipt,
  CapsuleLifecycleState,
  CapsuleRootfsImagePin,
  CapsuleOperationRequestHash,
} from '@qiln/core/server'
import type { IncusFilePushOptions } from '../../../../incus/client/types'
import type { IncusDeviceMap } from '../../../../incus/client'
import type { ManagedVolume, ProvisioningFileTarget } from '../../resource/bootstrap/targets'
import type { CapsuleOperationTransitionOutput } from '../shared'

export interface SubmitCreateCapsuleInput {
  ownerId: string
  actor: CapsuleActorReference
  rootBranchName: string
  idempotencyKey: string
  blueprintName: string
  blueprintDigest: CapsuleBlueprintDigest
  cpu: string
  memory: string
}

export interface AcceptCreateCapsuleOperationInput extends SubmitCreateCapsuleInput {
  requestHash: CapsuleOperationRequestHash
  blueprintSnapshot: CapsuleBlueprint
  rootfsImagePin: CapsuleRootfsImagePin
}

export interface CreateCapsuleRepositoryResult {
  newlyAccepted: boolean
  receipt: CapsuleCreateReceipt
  operation: CapsuleOperationTransitionOutput
  capsule: CapsuleLifecycleState
  branch: CreateCapsuleCommittedBranch
}

export interface CreateCapsuleCommittedBranch {
  id: string
  capsuleId: string
  name: string
  status: CapsuleBranchStatus
}

export interface CreateCapsuleTerminalResult {
  operation: CapsuleOperationTransitionOutput
  capsule: CapsuleLifecycleState
  branch: CreateCapsuleCommittedBranch | null
}

export interface CreateCapsuleExecutionInput {
  operationId: string
  capsuleId: string
  ownerId: string
  rootBranchId: string
  rootBranchName: string
  blueprintName: string
  blueprintDigest: CapsuleBlueprintDigest
  blueprintSnapshot: CapsuleBlueprint
  rootfsImagePin: CapsuleRootfsImagePin
  cpu: string
  memory: string
}

export interface CreateCapsuleOperationContext {
  readonly operationId: string
  readonly capsuleId: string
  readonly ownerId: string
  readonly rootBranchId: string
  readonly rootBranchName: string
  readonly namespace: string
}

export interface CreateCapsulePlannedResource {
  resourceKey: string
  resourceType: CapsuleBranchResourceTypeValue
  blueprintVolumeName: CapsuleBlueprintIdentifier | null
  cleanupPolicy: CapsuleBranchResourceCleanupPolicyValue
  metadata: Record<string, unknown>
}

export interface CreateCapsuleProjectResource extends CreateCapsulePlannedResource {
  kind: 'project'
  namespace: string
}

export interface CreateCapsuleBindMountResource extends CreateCapsulePlannedResource {
  kind: 'bindMount'
  deviceName: string
  hostPath: string
  mountPath: string
  readonly: boolean
  shifted: boolean
}

export interface CreateCapsuleVolumeResource extends CreateCapsulePlannedResource {
  kind: 'volume'
  volumeType: 'empty' | 'clone'
  deviceName: string
  pool: string
  volumeName: string
  mountPath: string
  readonly: boolean
  shifted: boolean
  sourceVolume: string | null
  sourceProject?: string
  config: Record<string, string>
}

export interface CreateCapsuleInstanceResource extends CreateCapsulePlannedResource {
  kind: 'instance'
  instanceName: string
  rootfsImagePin: CapsuleRootfsImagePin
  config: Record<string, string>
  devices: IncusDeviceMap
}

export interface CreateCapsuleProvisioningFileResource extends CreateCapsulePlannedResource {
  kind: 'provisioningFile'
  path: string
  content: string
  target: ProvisioningFileTarget
  options: IncusFilePushOptions
}

export interface CreateCapsuleResourcePlan {
  project: CreateCapsuleProjectResource
  bindMounts: CreateCapsuleBindMountResource[]
  volumes: CreateCapsuleVolumeResource[]
  instance: CreateCapsuleInstanceResource
  files: CreateCapsuleProvisioningFileResource[]
  managedVolumes: ManagedVolume[]
}

export interface CreateCapsuleResourcePlanInput {
  namespace: string
  rootBranchId: string
  rootBranchName: string
  cpu: string
  memory: string
  blueprint: CapsuleBlueprint
  rootfsImagePin: CapsuleRootfsImagePin
}
