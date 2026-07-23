import { and, asc, eq, isNotNull } from 'drizzle-orm'
import {
  capsuleArtifactManifestsTable,
  capsuleOperationsTable,
  capsuleSnapshotCaptureOperationsTable,
  capsuleSnapshotsTable,
  capsulesTable,
  type CapsuleHostDbContract,
} from '@qiln/core/server'
import { IncusError } from '../../../errors'
import type { CapsuleSnapshotRecord } from './types'

/**
 * Persistence boundary for committed capsule snapshot history.
 *
 * Snapshot history reads first prove capsule ownership. Missing and foreign
 * capsules are intentionally indistinguishable.
 *
 * A snapshot is visible only when PostgreSQL contains:
 *
 * - Its artifact-manifest header;
 * - A capture-operation extension linked to that snapshot;
 * - Identical immutable source-branch and capture-policy evidence in the
 *   operation extension and committed snapshot;
 * - A completed base operation with a completion timestamp;
 * - Matching capsule and owner identity across the complete linkage.
 *
 * Phase 1 intentionally has no writer, so fresh databases return an empty
 * committed history. Partial, manually inserted, unlinked, or digest-only rows
 * cannot cross this read boundary.
 */
export class CapsuleSnapshotStore {
  constructor(private readonly db: CapsuleHostDbContract) {}

  public async listForOwner(ownerId: string, capsuleId: string): Promise<CapsuleSnapshotRecord[]> {
    const [capsule] = await this.db
      .select({
        id: capsulesTable.id,
      })
      .from(capsulesTable)
      .where(and(eq(capsulesTable.id, capsuleId), eq(capsulesTable.ownerId, ownerId)))
      .limit(1)
    if (!capsule) {
      throw new IncusError('Capsule not found.', 'NOT_FOUND', {
        capsuleId,
      })
    }
    return await this.db
      .select({
        id: capsuleSnapshotsTable.id,
        capsuleId: capsuleSnapshotsTable.capsuleId,
        sourceBranchId: capsuleSnapshotsTable.sourceBranchId,
        sourceBranchName: capsuleSnapshotsTable.sourceBranchName,
        sourceBranchResourceInventoryDigest: capsuleSnapshotsTable.sourceBranchResourceInventoryDigest,
        capturePolicySchemaVersion: capsuleSnapshotsTable.capturePolicySchemaVersion,
        capturePolicyDigest: capsuleSnapshotsTable.capturePolicyDigest,
        capturePolicyPin: capsuleSnapshotsTable.capturePolicyPin,
        artifactManifestSchemaVersion: capsuleArtifactManifestsTable.schemaVersion,
        artifactManifestDigest: capsuleArtifactManifestsTable.digest,
        createdAt: capsuleSnapshotsTable.createdAt,
        archivedAt: capsuleSnapshotsTable.archivedAt,
      })
      .from(capsuleSnapshotsTable)
      .innerJoin(capsuleArtifactManifestsTable, eq(capsuleArtifactManifestsTable.snapshotId, capsuleSnapshotsTable.id))
      .innerJoin(
        capsuleSnapshotCaptureOperationsTable,
        and(
          eq(capsuleSnapshotCaptureOperationsTable.snapshotId, capsuleSnapshotsTable.id),
          eq(capsuleSnapshotCaptureOperationsTable.sourceBranchId, capsuleSnapshotsTable.sourceBranchId),
          eq(capsuleSnapshotCaptureOperationsTable.sourceBranchName, capsuleSnapshotsTable.sourceBranchName),
          eq(
            capsuleSnapshotCaptureOperationsTable.sourceBranchResourceInventoryDigest,
            capsuleSnapshotsTable.sourceBranchResourceInventoryDigest,
          ),
          eq(
            capsuleSnapshotCaptureOperationsTable.capturePolicySchemaVersion,
            capsuleSnapshotsTable.capturePolicySchemaVersion,
          ),
          eq(capsuleSnapshotCaptureOperationsTable.capturePolicyDigest, capsuleSnapshotsTable.capturePolicyDigest),
          eq(capsuleSnapshotCaptureOperationsTable.capturePolicyPin, capsuleSnapshotsTable.capturePolicyPin),
        ),
      )
      .innerJoin(
        capsuleOperationsTable,
        and(
          eq(capsuleOperationsTable.id, capsuleSnapshotCaptureOperationsTable.operationId),
          eq(capsuleOperationsTable.ownerId, ownerId),
          eq(capsuleOperationsTable.capsuleId, capsuleSnapshotsTable.capsuleId),
          eq(capsuleOperationsTable.status, 'completed'),
          isNotNull(capsuleOperationsTable.completedAt),
        ),
      )
      .where(eq(capsuleSnapshotsTable.capsuleId, capsule.id))
      .orderBy(asc(capsuleSnapshotsTable.createdAt), asc(capsuleSnapshotsTable.id))
  }
}
