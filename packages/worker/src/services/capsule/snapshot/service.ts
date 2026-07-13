import { CapsuleSnapshotListOutputSchema, type CapsuleSnapshotListOutput } from '@qiln/core/server'
import { IncusError } from '../../../errors'
import type { CapsuleSnapshotRecord } from './types'
import type { CapsuleSnapshotStore } from '../stores/snapshotStore'

function toIsoTimestamp(value: Date, field: string): string {
  const timestamp = value.getTime()
  if (!Number.isFinite(timestamp)) {
    throw new IncusError('Capsule snapshot contains an invalid timestamp.', 'API_ERROR', {
      field,
    })
  }
  return value.toISOString()
}

/**
 * Maps persistence rows into the client-safe snapshot history contract.
 *
 * The map is explicit so database Date objects cannot cross the Capsule Channel
 * or accidentally become part of a transport-specific public API.
 */
export class CapsuleSnapshotService {
  constructor(private readonly snapshots: CapsuleSnapshotStore) {}

  public async list(capsuleId: string): Promise<CapsuleSnapshotListOutput> {
    const snapshots = await this.snapshots.listSnapshotsForCapsule(capsuleId)
    return CapsuleSnapshotListOutputSchema.parse(snapshots.map(snapshot => this.toSummary(snapshot)))
  }

  private toSummary(snapshot: CapsuleSnapshotRecord) {
    return {
      id: snapshot.id,
      capsuleId: snapshot.capsuleId,
      sourceBranchId: snapshot.sourceBranchId,
      artifactManifest: {
        schemaVersion: snapshot.artifactManifestSchemaVersion,
        digest: snapshot.artifactManifestDigest,
      },
      createdAt: toIsoTimestamp(snapshot.createdAt, 'createdAt'),
      archivedAt: snapshot.archivedAt === null ? null : toIsoTimestamp(snapshot.archivedAt, 'archivedAt'),
    }
  }
}
