import type {
  CapsuleBlueprint,
  CapsuleBlueprintDigest,
  CapsuleOperationCleanupPolicy,
  CapsuleOperationResourceStatus,
  CapsuleOperationResourceType,
} from '@qiln/core/server'
import type { ManagedVolume } from '../../../provisioning/fileTargets'
import type { InstanceCreateInput, ProvisioningFileWriteInput, VolumeCreateInput } from '../../../resources/types'

export interface PlannedOperationResource {
  resourceType: CapsuleOperationResourceType
  resourceKey: string
  cleanupPolicy: CapsuleOperationCleanupPolicy
  status?: CapsuleOperationResourceStatus
  metadata?: Record<string, unknown>
}

export interface PlannedProjectResource extends PlannedOperationResource {
  kind: 'project'
  namespace: string
}

export interface PlannedBindMountResource extends PlannedOperationResource {
  kind: 'bindMount'
  deviceName: string
  hostPath: string
  mountPath: string
  readonly: boolean
  shifted: boolean
}

export interface PlannedVolumeResource extends PlannedOperationResource, VolumeCreateInput {
  kind: 'volume'
  deviceName: string
  mountPath: string
  readonly: boolean
  shifted: boolean
}

export interface PlannedInstanceResource extends PlannedOperationResource, InstanceCreateInput {
  kind: 'instance'
}

export type PlannedProvisioningFile = ProvisioningFileWriteInput

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
