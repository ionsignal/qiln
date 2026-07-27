import type {
  CapsuleArtifactManifestDigest,
  CapsuleBlueprintDigest,
  CapsuleBlueprintPin,
  CapsuleBranchName,
  CapsuleBranchResourceInventoryDigest,
  CapsuleSnapshotCapturePolicyDigest,
  CapsuleSnapshotCapturePolicyPin,
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
  mode: CapsuleSnapshotModeValue
  limitations: CapsuleSnapshotLimitationValue[]
  createdAt: Date
  archivedAt: Date | null
}

export interface CapsuleSnapshotListOptions {
  includeExperimental?: boolean
}
