import type {
  CapsuleArtifactManifestDigest,
  CapsuleBlueprintDigest,
  CapsuleBlueprintPin,
  CapsuleBranchName,
  CapsuleBranchResourceInventoryDigest,
  CapsuleSnapshotCapturePolicyDigest,
  CapsuleSnapshotCapturePolicyPin,
  CapsuleSnapshotAgentArtifactContentPolicyValue,
  CapsuleSnapshotLimitationValue,
  CapsuleSnapshotModeValue,
} from '@qiln/core/server'

/**
 * Worker persistence shape for committed capsule snapshot headers.
 *
 * Detailed manifest entries, Git records, dependency references, and provider
 * references remain server-side and are not included in this read projection.
 */
export interface CapsuleSnapshotRecord {
  id: string
  capsuleId: string
  sourceBranchId: string
  sourceBranchName: CapsuleBranchName
  sourceBranchResourceInventoryDigest: CapsuleBranchResourceInventoryDigest
  blueprintSchemaVersion: number
  blueprintName: string
  blueprintDigest: CapsuleBlueprintDigest
  blueprintPin: CapsuleBlueprintPin
  capturePolicySchemaVersion: number
  capturePolicyDigest: CapsuleSnapshotCapturePolicyDigest
  capturePolicyPin: CapsuleSnapshotCapturePolicyPin
  artifactManifestSchemaVersion: number
  artifactManifestDigest: CapsuleArtifactManifestDigest
  agentArtifactContentPolicy: CapsuleSnapshotAgentArtifactContentPolicyValue
  mode: CapsuleSnapshotModeValue
  limitations: CapsuleSnapshotLimitationValue[]
  createdAt: Date
  archivedAt: Date | null
}

/**
 * Minimal immutable snapshot projection used by agent-context selection before
 * the artifact store proves that the candidate's complete manifest remains
 * readable.
 */
export interface CapsuleSnapshotSelectionCandidate {
  id: string
  sourceBranchId: string
  sourceBranchName: CapsuleBranchName
  createdAt: Date
  agentArtifactContentPolicy: CapsuleSnapshotAgentArtifactContentPolicyValue
}

export interface CapsuleSnapshotListOptions {
  includeExperimental?: boolean
}
