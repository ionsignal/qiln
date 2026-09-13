import type {
  CapsuleBlueprint,
  CapsuleBlueprintIdentifier,
  CapsuleBranchResourceCleanupPolicyValue,
  CapsuleBranchResourceTypeValue,
  CapsuleRootfsImagePin,
} from '@qiln/core/server'
import type { IncusFilePushOptions } from '../../../incus/client/types'
import type { IncusDeviceMap } from '../../../incus/client'
import type { AttachedVolume, ProvisioningFileTarget } from './bootstrap/targets'

export type {
  BindMountResourceMetadata,
  InstanceResourceMetadata,
  ProjectResourceMetadata,
  ProvisioningFileResourceMetadata,
  VolumeResourceMetadata,
} from './metadata'

/**
 * Expected identity of one pre-materialized create resource.
 *
 * This input authorizes no insertion. Resource transitions compare it with the
 * locked ledger and the running create operation before provider work.
 *
 * Managed volumes and bind mounts retain their originating Blueprint volume
 * identity. Bind mounts remain unversioned external configuration.
 */
export interface BranchResourceInput {
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

export interface VolumeCreateInput {
  volumeType: 'empty' | 'clone'
  pool: string
  volumeName: string
  sourceVolume: string | null
  sourceProject?: string
  config: Record<string, string>
}

export interface VolumeDeleteInput {
  pool: string
  volumeName: string
}

export interface InstanceCreateInput {
  instanceName: string
  rootfsImagePin: CapsuleRootfsImagePin
  config: Record<string, string>
  devices: IncusDeviceMap
}

export interface ProvisioningFileWriteInput {
  path: string
  content: string
  target: ProvisioningFileTarget
  options: IncusFilePushOptions
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
  attachedVolumes: AttachedVolume[]
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
