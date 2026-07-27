import { and, asc, eq, isNotNull, or } from 'drizzle-orm'
import {
  CapsuleOperationType,
  CapsuleSnapshotMode,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import { IncusError } from '../../../errors'
import type { CapsuleSnapshotListOptions, CapsuleSnapshotRecord } from './types'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

/**
 * Persistence boundary for committed capsule snapshot history.
 *
 * Experimental visibility changes only which committed rows are returned. It
 * does not weaken ownership, operation completion, manifest linkage, immutable
 * Blueprint evidence, or immutable capture-policy checks.
 */
export class CapsuleSnapshotStore<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly persistence: CapsulePersistence<TDatabase, TTables>) {}

  public async list(
    ownerId: string,
    capsuleId: string,
    options: CapsuleSnapshotListOptions = {},
  ): Promise<CapsuleSnapshotRecord[]> {
    const db = this.persistence.db
    const {
      capsules,
      capsuleOperations,
      capsuleSnapshots,
      capsuleArtifactManifests,
      capsuleSnapshotCaptureOperations,
    } = this.persistence.tables
    const [capsule] = await db
      .select({
        id: capsules.id,
      })
      .from(capsules)
      .where(and(eq(capsules.id, capsuleId), eq(capsules.ownerId, ownerId)))
      .limit(1)
    if (!capsule) {
      throw new IncusError('Capsule not found.', 'NOT_FOUND', {
        capsuleId,
      })
    }
    const visibility = options.includeExperimental ? undefined : eq(capsuleSnapshots.mode, CapsuleSnapshotMode.HARDENED)
    return await db
      .select({
        id: capsuleSnapshots.id,
        capsuleId: capsuleSnapshots.capsuleId,
        sourceBranchId: capsuleSnapshots.sourceBranchId,
        sourceBranchName: capsuleSnapshots.sourceBranchName,
        sourceBranchResourceInventoryDigest: capsuleSnapshots.sourceBranchResourceInventoryDigest,
        blueprintSchemaVersion: capsuleSnapshots.blueprintSchemaVersion,
        blueprintName: capsuleSnapshots.blueprintName,
        blueprintDigest: capsuleSnapshots.blueprintDigest,
        blueprintPin: capsuleSnapshots.blueprintPin,
        capturePolicySchemaVersion: capsuleSnapshots.capturePolicySchemaVersion,
        capturePolicyDigest: capsuleSnapshots.capturePolicyDigest,
        capturePolicyPin: capsuleSnapshots.capturePolicyPin,
        artifactManifestSchemaVersion: capsuleArtifactManifests.schemaVersion,
        artifactManifestDigest: capsuleArtifactManifests.digest,
        mode: capsuleSnapshots.mode,
        limitations: capsuleSnapshots.limitations,
        createdAt: capsuleSnapshots.createdAt,
        archivedAt: capsuleSnapshots.archivedAt,
      })
      .from(capsuleSnapshots)
      .innerJoin(capsuleArtifactManifests, eq(capsuleArtifactManifests.snapshotId, capsuleSnapshots.id))
      .innerJoin(
        capsuleSnapshotCaptureOperations,
        and(
          eq(capsuleSnapshotCaptureOperations.snapshotId, capsuleSnapshots.id),
          eq(capsuleSnapshotCaptureOperations.sourceBranchId, capsuleSnapshots.sourceBranchId),
          eq(capsuleSnapshotCaptureOperations.sourceBranchName, capsuleSnapshots.sourceBranchName),
          eq(
            capsuleSnapshotCaptureOperations.sourceBranchResourceInventoryDigest,
            capsuleSnapshots.sourceBranchResourceInventoryDigest,
          ),
          eq(capsuleSnapshotCaptureOperations.blueprintSchemaVersion, capsuleSnapshots.blueprintSchemaVersion),
          eq(capsuleSnapshotCaptureOperations.blueprintName, capsuleSnapshots.blueprintName),
          eq(capsuleSnapshotCaptureOperations.blueprintDigest, capsuleSnapshots.blueprintDigest),
          eq(capsuleSnapshotCaptureOperations.blueprintPin, capsuleSnapshots.blueprintPin),
          eq(capsuleSnapshotCaptureOperations.capturePolicySchemaVersion, capsuleSnapshots.capturePolicySchemaVersion),
          eq(capsuleSnapshotCaptureOperations.capturePolicyDigest, capsuleSnapshots.capturePolicyDigest),
          eq(capsuleSnapshotCaptureOperations.capturePolicyPin, capsuleSnapshots.capturePolicyPin),
          eq(capsuleSnapshotCaptureOperations.requestedMode, capsuleSnapshots.mode),
        ),
      )
      .innerJoin(
        capsuleOperations,
        and(
          eq(capsuleOperations.id, capsuleSnapshotCaptureOperations.operationId),
          eq(capsuleOperations.ownerId, ownerId),
          eq(capsuleOperations.capsuleId, capsuleSnapshots.capsuleId),
          eq(capsuleOperations.type, CapsuleOperationType.SNAPSHOT_CAPTURE),
          eq(capsuleOperations.status, 'completed'),
          isNotNull(capsuleOperations.completedAt),
        ),
      )
      .where(
        and(
          eq(capsuleSnapshots.capsuleId, capsule.id),
          visibility ??
            or(
              eq(capsuleSnapshots.mode, CapsuleSnapshotMode.EXPERIMENTAL),
              eq(capsuleSnapshots.mode, CapsuleSnapshotMode.HARDENED),
            ),
        ),
      )
      .orderBy(asc(capsuleSnapshots.createdAt), asc(capsuleSnapshots.id))
  }
}
