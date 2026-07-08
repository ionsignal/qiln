import type {
  CapsuleBlueprint,
  CapsuleBlueprintDigest,
  CapsuleBranchResourceCleanupPolicy,
  CapsuleBranchResourceStatus,
  CapsuleBranchResourceType,
} from '@qiln/core/server'
import type { ManagedVolume } from '../../../provisioning/fileTargets'
import type { InstanceCreateInput, ProvisioningFileWriteInput, VolumeCreateInput } from '../../../resources/types'

export interface PlannedBranchResource {
  resourceType: CapsuleBranchResourceType
  resourceKey: string
  cleanupPolicy: CapsuleBranchResourceCleanupPolicy
  status?: CapsuleBranchResourceStatus
  metadata?: Record<string, unknown>
}

export interface PlannedProjectResource extends PlannedBranchResource {
  kind: 'project'
  namespace: string
}

export interface PlannedBindMountResource extends PlannedBranchResource {
  kind: 'bindMount'
  deviceName: string
  hostPath: string
  mountPath: string
  readonly: boolean
  shifted: boolean
}

export interface PlannedVolumeResource extends PlannedBranchResource, VolumeCreateInput {
  kind: 'volume'
  deviceName: string
  mountPath: string
  readonly: boolean
  shifted: boolean
}

export interface PlannedInstanceResource extends PlannedBranchResource, InstanceCreateInput {
  kind: 'instance'
}

export interface PlannedProvisioningFileResource extends PlannedBranchResource, ProvisioningFileWriteInput {
  kind: 'provisioningFile'
}

export type PlannedProvisioningFile = PlannedProvisioningFileResource

export interface CapsuleBranchCreateResourcePlan {
  project: PlannedProjectResource
  bindMounts: PlannedBindMountResource[]
  volumes: PlannedVolumeResource[]
  instance: PlannedInstanceResource
  files: PlannedProvisioningFile[]
  managedVolumes: ManagedVolume[]
}

export interface CapsuleBranchCreatePlanInput {
  ownerId: string
  namespace: string
  name: string
  cpu: string
  memory: string
  blueprint: CapsuleBlueprint
}

export interface CapsuleBranchCreateSagaInput {
  ownerId: string
  name: string
  blueprintName: string
  blueprintDigest: CapsuleBlueprintDigest
  idempotencyKey: string
  cpu: string
  memory: string
}

export type RollbackCallback = () => Promise<void>
