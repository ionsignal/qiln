import { and, asc, eq } from 'drizzle-orm'
import { capsuleSnapshotsTable, capsulesTable, type CapsuleHostDbContract } from '@qiln/core/server'
import { IncusError } from '../../../errors'
import type { CapsuleSnapshotRecord } from './types'

/**
 * Persistence boundary for committed logical capsule snapshot history.
 *
 * Snapshot history reads prove capsule ownership before querying snapshot rows.
 * Missing and foreign capsules are intentionally indistinguishable.
 *
 * This store intentionally has no writer. Snapshot capture must later validate
 * source-branch membership, artifact manifests, and physical references in one
 * dedicated durable operation.
 */
export class CapsuleSnapshotStore {
  constructor(private readonly db: CapsuleHostDbContract) {}

  public async listSnapshotsForOwnedCapsule(ownerId: string, capsuleId: string): Promise<CapsuleSnapshotRecord[]> {
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
        artifactManifestSchemaVersion: capsuleSnapshotsTable.artifactManifestSchemaVersion,
        artifactManifestDigest: capsuleSnapshotsTable.artifactManifestDigest,
        createdAt: capsuleSnapshotsTable.createdAt,
        archivedAt: capsuleSnapshotsTable.archivedAt,
      })
      .from(capsuleSnapshotsTable)
      .where(eq(capsuleSnapshotsTable.capsuleId, capsule.id))
      .orderBy(asc(capsuleSnapshotsTable.createdAt), asc(capsuleSnapshotsTable.id))
  }
}
