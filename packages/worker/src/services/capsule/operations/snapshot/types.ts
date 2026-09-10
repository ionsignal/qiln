import type {
  CapsuleActorReference,
  CapsuleBlueprintPin,
  CapsuleBranchResourceInventoryDigest,
  CapsuleBranchStatus,
  CapsuleLifecycleState,
  CapsuleOperationRequestHash,
  CapsuleRootfsImagePin,
  CapsuleSnapshotCreateReceipt,
  CapsuleTables,
} from '@qiln/core/server'
import type { CapsuleOperationTransitionOutput } from '../shared/types'

export interface SnapshotSubmissionInput {
  ownerId: string
  actor: CapsuleActorReference
  capsuleId: string
  sourceBranchId: string
  idempotencyKey: string
}

export interface SnapshotAcceptanceInput extends SnapshotSubmissionInput {
  requestHash: CapsuleOperationRequestHash
}

export interface SnapshotVolume {
  blueprintVolumeName: string
  sourceBranchResourceId: string
  provider: 'incus'
  kind: 'custom_volume_snapshot'
  project: string
  pool: string
  sourceVolume: string
  snapshotName: string
}

export interface SnapshotPlan {
  project: string
  instanceName: string
  inventoryDigest: CapsuleBranchResourceInventoryDigest
  volumes: SnapshotVolume[]
}

export interface SnapshotExecution {
  operationId: string
  ownerId: string
  capsuleId: string
  sourceBranchId: string
  sourceBranchName: string
  blueprint: CapsuleBlueprintPin
  rootfsImagePin: CapsuleRootfsImagePin
  plan: SnapshotPlan
}

/**
 * Unobserved means no live offline check has started. It permits restoration of
 * accepted offline state only when provider accounting remains untouched.
 *
 * An uncertain observation cannot be replaced by successful snapshot cleanup.
 * Compensated live failure requires a fresh positive offline observation.
 */
export type SnapshotRuntimeEvidence = 'unobserved' | 'offline' | 'uncertain'

export type SnapshotFailureInput = {
  operationId: string
  error: unknown
} & (
  | {
      origin: 'live'
      runtime: SnapshotRuntimeEvidence
      compensated: boolean
      finalizationAttempted: boolean
    }
  | {
      origin: 'abandoned'
    }
)

export interface SnapshotBranch {
  id: string
  capsuleId: string
  name: string
  status: CapsuleBranchStatus
}

export interface SnapshotTransition {
  operation: CapsuleOperationTransitionOutput
  capsule: CapsuleLifecycleState
  branches: SnapshotBranch[]
}

export interface SnapshotAcceptance extends SnapshotTransition {
  newlyAccepted: boolean
  receipt: CapsuleSnapshotCreateReceipt
}

export interface SnapshotCommit extends SnapshotTransition {
  snapshotId: string
}

export type SnapshotResource = CapsuleTables['capsuleSnapshotCreateResources']['$inferSelect']

export interface SnapshotCompensation {
  complete: boolean
  failures: Array<{
    resourceId: string
    code: string
  }>
}
