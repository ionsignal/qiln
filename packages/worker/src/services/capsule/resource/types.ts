import type {
  CapsuleBlueprintIdentifier,
  CapsuleBranchResourceCleanupPolicyValue,
  CapsuleBranchResourceStatusValue,
  CapsuleBranchResourceTypeValue,
} from '@qiln/core/server'
import type { IncusFilePushOptions } from '../../../incus/client/types'
import type { IncusDeviceMap } from '../../../incus/client'
import type { ProvisioningFileTarget } from './bootstrap/targets'

export type {
  BindMountResourceMetadata,
  InstanceResourceMetadata,
  ProjectResourceMetadata,
  ProvisioningFileResourceMetadata,
  VolumeResourceMetadata,
} from './metadata'

/**
 * Durable input used to associate a branch resource with the operation that
 * first established its Qiln ownership record.
 *
 * Operation-specific repositories continue to own operation acceptance and
 * aggregate transitions. This contract contains only branch resource identity,
 * cleanup policy, metadata, and creation provenance.
 *
 * Managed volumes and bind mounts retain their originating blueprint volume
 * identity. Snapshot Capture must resolve policy roots and external boundaries
 * through this identity rather than provider names, mount paths, or live
 * provider discovery.
 */
export interface BranchResourceInput {
  operationId: string
  ownerId: string
  branchId: string
  branchName: string
  resourceType: CapsuleBranchResourceTypeValue
  resourceKey: string
  blueprintVolumeName: CapsuleBlueprintIdentifier | null
  cleanupPolicy: CapsuleBranchResourceCleanupPolicyValue
  provider?: string
  metadata?: Record<string, unknown>
}

/**
 * Durable resource evidence consumed by inventory verification and fail-closed
 * destroy planning.
 */
export interface CapsuleBranchResourceInventoryRow {
  id: string
  ownerId: string
  branchId: string | null
  branchName: string
  provider: string
  resourceType: CapsuleBranchResourceTypeValue
  resourceKey: string
  blueprintVolumeName: CapsuleBlueprintIdentifier | null
  status: CapsuleBranchResourceStatusValue
  cleanupPolicy: CapsuleBranchResourceCleanupPolicyValue
  metadata: Record<string, unknown> | null
  createdByOperationId: string | null
  lastOperationId: string | null
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
  imageAlias: string
  config: Record<string, string>
  devices: IncusDeviceMap
}

export interface ProvisioningFileWriteInput {
  path: string
  content: string
  target: ProvisioningFileTarget
  options: IncusFilePushOptions
}
