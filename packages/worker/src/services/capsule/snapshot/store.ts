import { asc, eq } from 'drizzle-orm'
import { capsuleSnapshotsTable, capsulesTable, type CapsuleHostDbContract } from '@qiln/core/server'
import { IncusError } from '../../../errors'
import type { CapsuleSnapshotRecord } from './types'

/**
 * Persistence boundary for committed logical capsule snapshot history.
 *
 * This store intentionally has no writer. Snapshot capture must later validate
 * source-branch membership, artifact manifests, and physical references in one
 * dedicated durable operation.
 */
export class CapsuleSnapshotStore {
  constructor(private readonly db: CapsuleHostDbContract) {}

  public async listSnapshotsForCapsule(capsuleId: string): Promise<CapsuleSnapshotRecord[]> {
    const [capsule] = await this.db
      .select({
        id: capsulesTable.id,
      })
      .from(capsulesTable)
      .where(eq(capsulesTable.id, capsuleId))
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
      .where(eq(capsuleSnapshotsTable.capsuleId, capsuleId))
      .orderBy(asc(capsuleSnapshotsTable.createdAt), asc(capsuleSnapshotsTable.id))
  }
}
