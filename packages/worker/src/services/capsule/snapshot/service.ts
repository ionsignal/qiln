import {
  CapsuleSnapshotLimitationsSchema,
  CapsuleSnapshotListOutputSchema,
  CapsuleSnapshotMode,
  verifyCapsuleSnapshotCapturePolicyPin,
  type CapsuleSnapshotListOutput,
} from '@qiln/core/server'
import { IncusError } from '../../../errors'
import type { CapsuleSnapshotListOptions, CapsuleSnapshotRecord } from './types'
import type { CapsuleSnapshotStore } from './store'

function toIsoTimestamp(value: Date, field: string, snapshotId: string): string {
  if (!(value instanceof Date)) {
    throw new IncusError('Capsule snapshot contains a non-Date timestamp.', 'API_ERROR', {
      snapshotId,
      field,
      valueType: typeof value,
    })
  }
  const timestamp = value.getTime()
  if (!Number.isFinite(timestamp)) {
    throw new IncusError('Capsule snapshot contains an invalid timestamp.', 'API_ERROR', {
      snapshotId,
      field,
    })
  }
  return value.toISOString()
}

/**
 * Maps committed persistence rows into the client-safe snapshot history
 * contract.
 */
export class CapsuleSnapshotService {
  constructor(private readonly snapshots: CapsuleSnapshotStore) {}

  public async listForOwner(
    ownerId: string,
    capsuleId: string,
    options: CapsuleSnapshotListOptions = {},
  ): Promise<CapsuleSnapshotListOutput> {
    const snapshots = await this.snapshots.listForOwner(ownerId, capsuleId, options)
    return CapsuleSnapshotListOutputSchema.parse(snapshots.map(snapshot => this.toSummary(snapshot)))
  }

  private toSummary(snapshot: CapsuleSnapshotRecord) {
    const capturePolicy = verifyCapsuleSnapshotCapturePolicyPin(snapshot.capturePolicyPin)
    if (
      capturePolicy.schemaVersion !== snapshot.capturePolicySchemaVersion ||
      capturePolicy.digest !== snapshot.capturePolicyDigest
    ) {
      throw new IncusError(
        'Committed capsule snapshot capture-policy evidence is internally inconsistent.',
        'API_ERROR',
        {
          snapshotId: snapshot.id,
          persistedSchemaVersion: snapshot.capturePolicySchemaVersion,
          pinSchemaVersion: capturePolicy.schemaVersion,
          persistedDigest: snapshot.capturePolicyDigest,
          pinDigest: capturePolicy.digest,
        },
      )
    }
    if (snapshot.mode !== CapsuleSnapshotMode.EXPERIMENTAL) {
      throw new IncusError('Committed capsule snapshot uses an unsupported evidence mode.', 'API_ERROR', {
        snapshotId: snapshot.id,
        mode: snapshot.mode,
      })
    }
    const limitations = CapsuleSnapshotLimitationsSchema.parse(snapshot.limitations)
    return {
      id: snapshot.id,
      capsuleId: snapshot.capsuleId,
      sourceBranchId: snapshot.sourceBranchId,
      sourceBranchName: snapshot.sourceBranchName,
      sourceBranchResourceInventoryDigest: snapshot.sourceBranchResourceInventoryDigest,
      capturePolicy: {
        schemaVersion: capturePolicy.schemaVersion,
        digest: capturePolicy.digest,
      },
      artifactManifest: {
        schemaVersion: snapshot.artifactManifestSchemaVersion,
        digest: snapshot.artifactManifestDigest,
      },
      mode: snapshot.mode,
      forkReady: false as const,
      limitations,
      createdAt: toIsoTimestamp(snapshot.createdAt, 'createdAt', snapshot.id),
      archivedAt: snapshot.archivedAt === null ? null : toIsoTimestamp(snapshot.archivedAt, 'archivedAt', snapshot.id),
    }
  }
}
