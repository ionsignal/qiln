import type {
  CapsuleBlueprintIdentifier,
  CapsuleBlueprintPin,
  CapsuleBranchResourceCleanupPolicyValue,
  CapsuleBranchResourceTypeValue,
  CapsuleRootfsImagePin,
} from '@qiln/core/server'
import type { IncusDeviceMap } from '../../../../../incus/client'
import type { IncusFilePushOptions } from '../../../../../incus/client/types'
import type { AttachedVolume, ProvisioningFileTarget } from '../../../resource/bootstrap/targets'

export interface CapsuleCreateResourceInput {
  operationId: string
  capsuleId: string
  ownerId: string
  branchId: string
  branchName: string
  resourceType: CapsuleBranchResourceTypeValue
  resourceKey: string
  blueprintVolumeName: CapsuleBlueprintIdentifier | null
  cleanupPolicy: CapsuleBranchResourceCleanupPolicyValue
  metadata: Record<string, unknown>
}

export interface CapsuleCreatePlannedResource {
  resourceKey: string
  resourceType: CapsuleBranchResourceTypeValue
  blueprintVolumeName: CapsuleBlueprintIdentifier | null
  cleanupPolicy: CapsuleBranchResourceCleanupPolicyValue
  metadata: Record<string, unknown>
}

export interface CapsuleCreateProjectResource extends CapsuleCreatePlannedResource {
  kind: 'project'
  namespace: string
}

export interface CapsuleCreateBindMountResource extends CapsuleCreatePlannedResource {
  kind: 'bindMount'
  deviceName: string
  hostPath: string
  mountPath: string
  readonly: boolean
  shifted: boolean
}

export interface CapsuleCreateVolumeResource extends CapsuleCreatePlannedResource {
  kind: 'volume'
  volumeType: 'empty' | 'clone'
  versioned: boolean
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

export interface CapsuleCreateInstanceResource extends CapsuleCreatePlannedResource {
  kind: 'instance'
  instanceName: string
  rootfsImagePin: CapsuleRootfsImagePin
  config: Record<string, string>
  devices: IncusDeviceMap
}

export interface CapsuleCreateProvisioningFileResource extends CapsuleCreatePlannedResource {
  kind: 'provisioningFile'
  path: string
  content: string
  target: ProvisioningFileTarget
  options: IncusFilePushOptions
}

export interface CapsuleCreateResourcePlan {
  project: CapsuleCreateProjectResource
  bindMounts: CapsuleCreateBindMountResource[]
  volumes: CapsuleCreateVolumeResource[]
  instance: CapsuleCreateInstanceResource
  files: CapsuleCreateProvisioningFileResource[]
  attachedVolumes: AttachedVolume[]
}

export interface CapsuleCreateResourcePlanInput {
  namespace: string
  rootBranchId: string
  rootBranchName: string
  cpu: string
  memory: string
  blueprintPin: CapsuleBlueprintPin
  rootfsImagePin: CapsuleRootfsImagePin
}
