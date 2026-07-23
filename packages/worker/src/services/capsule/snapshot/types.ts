import type {
  CapsuleArtifactManifestDigest,
  CapsuleBranchName,
  CapsuleBranchResourceInventoryDigest,
  CapsuleSnapshotCapturePolicyDigest,
  CapsuleSnapshotCapturePolicyPin,
} from '@qiln/core/server'

/**
 * Worker persistence shape for committed capsule snapshot headers.
 *
 * Rows reach this projection only when the snapshot has:
 *
 * - A canonical artifact-manifest header;
 * - A capture-operation extension linked to the snapshot;
 * - Matching immutable source and capture-policy evidence;
 * - A completed base operation.
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
  capturePolicySchemaVersion: number
  capturePolicyDigest: CapsuleSnapshotCapturePolicyDigest
  capturePolicyPin: CapsuleSnapshotCapturePolicyPin
  artifactManifestSchemaVersion: number
  artifactManifestDigest: CapsuleArtifactManifestDigest
  createdAt: Date
  archivedAt: Date | null
}
