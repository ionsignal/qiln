import type {
  CapsuleBlueprint,
  CapsuleBlueprintDigest,
  CapsuleBranchResourceCleanupPolicyValue,
  CapsuleBranchResourceTypeValue,
} from '@qiln/core/server'
import type { ManagedVolume } from '../provisioning/fileTargets'
import type { InstanceCreateInput, ProvisioningFileWriteInput, VolumeCreateInput } from '../resources/types'

export interface BootstrapPlannedResource {
  resourceKey: string
  resourceType: CapsuleBranchResourceTypeValue
  cleanupPolicy: CapsuleBranchResourceCleanupPolicyValue
  metadata?: Record<string, unknown>
}

export interface BootstrapProjectResource extends BootstrapPlannedResource {
  kind: 'project'
  namespace: string
}

export interface BootstrapBindMountResource extends BootstrapPlannedResource {
  kind: 'bindMount'
  deviceName: string
  hostPath: string
  mountPath: string
  readonly: boolean
  shifted: boolean
}

export interface BootstrapVolumeResource extends BootstrapPlannedResource, VolumeCreateInput {
  kind: 'volume'
  deviceName: string
  mountPath: string
  readonly: boolean
  shifted: boolean
}

export interface BootstrapInstanceResource extends BootstrapPlannedResource, InstanceCreateInput {
  kind: 'instance'
}

export interface BootstrapProvisioningFileResource extends BootstrapPlannedResource, ProvisioningFileWriteInput {
  kind: 'provisioningFile'
}

export interface BootstrapResourcePlan {
  project: BootstrapProjectResource
  bindMounts: BootstrapBindMountResource[]
  volumes: BootstrapVolumeResource[]
  instance: BootstrapInstanceResource
  files: BootstrapProvisioningFileResource[]
  managedVolumes: ManagedVolume[]
}

export interface BootstrapResourcePlanInput {
  ownerId: string
  namespace: string
  bootstrapBranchName: string
  cpu: string
  memory: string
  blueprint: CapsuleBlueprint
}

export interface BootstrapProvisioningInput {
  ownerId: string
  bootstrapBranchName: string
  blueprintName: string
  blueprintDigest: CapsuleBlueprintDigest
  idempotencyKey: string
  cpu: string
  memory: string
}

/**
 * Immutable identity shared by bootstrap implementation phases.
 *
 * Operation-local progress and safety facts live separately in `BootstrapExecutionState`.
 */
export interface BootstrapOperationContext {
  readonly operationId: string
  readonly capsuleId: string
  readonly ownerId: string
  readonly branchId: string
  readonly branchName: string
  readonly namespace: string
}

/**
 * Worker-internal root capsule creation input.
 *
 * The Capsule Channel has already validated protocol input before this reaches
 * the service. This shape keeps the service independent from transport targets.
 */
export interface CapsuleBootstrapCreateInput {
  ownerId: string
  bootstrapBranchName: string
  idempotencyKey: string
  blueprintName: string
  blueprintDigest: CapsuleBlueprintDigest
  cpu: string
  memory: string
}
