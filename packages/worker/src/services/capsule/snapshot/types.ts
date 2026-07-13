import type { CapsuleArtifactManifestDigest } from '@qiln/core/server'

/**
 * Worker persistence shape for immutable logical snapshot-record headers.
 *
 * A row exists only after a future capture operation can prove complete
 * artifacts and physical references. PR 2 only reads these records.
 */
export interface CapsuleSnapshotRecord {
  id: string
  capsuleId: string
  sourceBranchId: string
  artifactManifestSchemaVersion: number
  artifactManifestDigest: CapsuleArtifactManifestDigest
  createdAt: Date
  archivedAt: Date | null
}
