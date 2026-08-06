import type {
  CapsuleActorReference,
  CapsuleArtifactManifest,
  CapsuleArtifactManifestDigest,
  CapsuleBlueprintPin,
  CapsuleBranchName,
  CapsuleBranchResourceInventoryDigest,
  CapsuleBranchStatus,
  CapsuleLifecycleState,
  CapsuleOperationRequestHash,
  CapsuleSnapshotCapturePolicyPin,
  CapsuleSnapshotCaptureReceipt,
  CapsuleSnapshotAgentArtifactContentPolicyValue,
  CapsuleSnapshotGitRepository,
  CapsuleSnapshotLimitationValue,
  CapsuleSnapshotModeValue,
  CapsuleRootfsImagePin,
} from '@qiln/core/server'
import type { CapsuleOperationTransitionOutput } from '../shared'

export interface SubmitCaptureCapsuleInput {
  ownerId: string
  actor: CapsuleActorReference
  capsuleId: string
  sourceBranchId: string
  idempotencyKey: string
  agentArtifactContentPolicy: CapsuleSnapshotAgentArtifactContentPolicyValue
}

export interface AcceptCaptureCapsuleInput extends SubmitCaptureCapsuleInput {
  requestHash: CapsuleOperationRequestHash
}

export interface CaptureSourceBranch {
  id: string
  ownerId: string
  capsuleId: string
  name: CapsuleBranchName
  status: CapsuleBranchStatus
  isRootBranch: boolean
  blueprintName: string
  blueprintDigest: string
  cpu: string
  memory: string
  resourceInventoryDigest: CapsuleBranchResourceInventoryDigest | null
}

export interface CaptureCommittedBranch {
  id: string
  capsuleId: string
  name: string
  status: CapsuleBranchStatus
}

export interface CaptureRootPlan {
  artifactRootId: string
  blueprintVolumeName: string
  sourceBranchResourceId: string
  provider: 'incus'
  kind: 'custom_volume_snapshot'
  project: string
  pool: string
  sourceVolume: string
  snapshotName: string
}

export interface CaptureDependencyPlan {
  artifactRootId: string
  blueprintVolumeName: string
  sourceBranchResourceId: string
  kind: 'model_vault'
  logicalId: string
  required: boolean
  logicalPath: string
}

export interface CapturePlan {
  roots: CaptureRootPlan[]
  dependencies: CaptureDependencyPlan[]
}

export interface CaptureResourceRecord {
  id: string
  operationId: string
  sourceBranchResourceId: string
  artifactRootId: string
  blueprintVolumeName: string
  provider: 'incus'
  kind: 'custom_volume_snapshot'
  project: string
  pool: string
  sourceVolume: string
  snapshotName: string
  status: 'planned' | 'creating' | 'created' | 'deleting' | 'deleted' | 'missing' | 'error'
  snapshotIntentAt: Date | null
  snapshotCreatedAt: Date | null
  cleanupIntentAt: Date | null
  cleanupCompletedAt: Date | null
  failureCode: string | null
  failureMessage: string | null
  failureDetails: Record<string, unknown> | null
  failureAt: Date | null
}

export interface CaptureAcceptanceResult {
  newlyAccepted: boolean
  receipt: CapsuleSnapshotCaptureReceipt
  operation: CapsuleOperationTransitionOutput
  capsule: CapsuleLifecycleState
  branch: CaptureCommittedBranch
}

export interface CaptureExecutionInput {
  operationId: string
  ownerId: string
  capsuleId: string
  sourceBranchId: string
  sourceBranchName: CapsuleBranchName
  sourceBranchResourceInventoryDigest: CapsuleBranchResourceInventoryDigest
  blueprint: CapsuleBlueprintPin
  rootfsImagePin: CapsuleRootfsImagePin
  requestedMode: CapsuleSnapshotModeValue
  agentArtifactContentPolicy: CapsuleSnapshotAgentArtifactContentPolicyValue
  capturePolicy: CapsuleSnapshotCapturePolicyPin
  plan: CapturePlan
}

export interface CaptureRunningResult {
  operation: CapsuleOperationTransitionOutput
}

export interface CaptureResourceFailure {
  resourceId: string
  artifactRootId: string
  code: string
  message: string
  details?: Record<string, unknown>
}

export interface CaptureProviderResult {
  created: readonly CaptureResourceRecord[]
}

export interface CaptureCompensationResult {
  complete: boolean
  resources: readonly CaptureResourceRecord[]
  failures: readonly CaptureResourceFailure[]
}

export interface CaptureCollectionEvidence {
  manifest: CapsuleArtifactManifest
  digest: CapsuleArtifactManifestDigest
  limitations: readonly CapsuleSnapshotLimitationValue[]
  entryCount: number
  totalBytes: number
}

export interface CaptureGitEvidence {
  repositories: readonly CapsuleSnapshotGitRepository[]
  limitations: readonly CapsuleSnapshotLimitationValue[]
}

export interface CommitCaptureInput {
  execution: CaptureExecutionInput
  collection: CaptureCollectionEvidence
  git: CaptureGitEvidence
}

export interface CaptureCommitResult extends CaptureTerminalResult {
  snapshotId: string
}

export interface CaptureTerminalResult {
  operation: CapsuleOperationTransitionOutput
  capsule: CapsuleLifecycleState
  branches: CaptureCommittedBranch[]
}

export type CaptureAbandonedClassificationResult = CaptureTerminalResult | null
