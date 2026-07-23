import { and, asc, eq, isNotNull } from 'drizzle-orm'
import {
  CapsuleOperationType,
  CapsuleSnapshotMode,
  capsuleArtifactManifestsTable,
  capsuleOperationsTable,
  capsuleSnapshotCaptureOperationsTable,
  capsuleSnapshotsTable,
  capsulesTable,
  type CapsuleHostDbContract,
} from '@qiln/core/server'
import { IncusError } from '../../../errors'
import type { CapsuleSnapshotListOptions, CapsuleSnapshotRecord } from './types'

/**
 * Persistence boundary for committed capsule snapshot history.
 *
 * Experimental visibility changes only which committed rows are returned. It
 * does not weaken ownership, operation completion, manifest linkage, or
 * immutable capture-evidence checks.
 */
export class CapsuleSnapshotStore {
  constructor(private readonly db: CapsuleHostDbContract) {}

  public async listForOwner(
    ownerId: string,
    capsuleId: string,
    options: CapsuleSnapshotListOptions = {},
  ): Promise<CapsuleSnapshotRecord[]> {
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
    if (!options.includeExperimental) {
      return []
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
        mode: capsuleSnapshotsTable.mode,
        limitations: capsuleSnapshotsTable.limitations,
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
          eq(capsuleSnapshotCaptureOperationsTable.requestedMode, capsuleSnapshotsTable.mode),
        ),
      )
      .innerJoin(
        capsuleOperationsTable,
        and(
          eq(capsuleOperationsTable.id, capsuleSnapshotCaptureOperationsTable.operationId),
          eq(capsuleOperationsTable.ownerId, ownerId),
          eq(capsuleOperationsTable.capsuleId, capsuleSnapshotsTable.capsuleId),
          eq(capsuleOperationsTable.type, CapsuleOperationType.SNAPSHOT_CAPTURE),
          eq(capsuleOperationsTable.status, 'completed'),
          isNotNull(capsuleOperationsTable.completedAt),
        ),
      )
      .where(
        and(
          eq(capsuleSnapshotsTable.capsuleId, capsule.id),
          eq(capsuleSnapshotsTable.mode, CapsuleSnapshotMode.EXPERIMENTAL),
        ),
      )
      .orderBy(asc(capsuleSnapshotsTable.createdAt), asc(capsuleSnapshotsTable.id))
  }
}
