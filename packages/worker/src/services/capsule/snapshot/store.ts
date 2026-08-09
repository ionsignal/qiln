import { and, asc, desc, eq, isNotNull, isNull, ne, or } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  CapsuleSnapshotMode,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import { IncusError } from '../../../errors'
import type { CapsuleSnapshotListOptions, CapsuleSnapshotRecord, CapsuleSnapshotSelectionCandidate } from './types'
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
        agentArtifactContentPolicy: capsuleSnapshots.agentArtifactContentPolicy,
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
          eq(capsuleSnapshotCaptureOperations.agentArtifactContentPolicy, capsuleSnapshots.agentArtifactContentPolicy),
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

  /**
   * Returns newest-first non-archived candidates backed by completed capture
   * operations. Passing a branch ID limits results to exact captures from that
   * branch; the selector independently verifies each candidate's immutable
   * manifest evidence before returning it to an agent.
   */
  public async candidates(
    ownerId: string,
    capsuleId: string,
    branchId?: string,
  ): Promise<CapsuleSnapshotSelectionCandidate[]> {
    const { capsules, capsuleOperations, capsuleSnapshots, capsuleSnapshotCaptureOperations } = this.persistence.tables
    const branchCondition = branchId === undefined ? undefined : eq(capsuleSnapshots.sourceBranchId, branchId)
    return await this.persistence.db
      .select({
        id: capsuleSnapshots.id,
        sourceBranchId: capsuleSnapshots.sourceBranchId,
        sourceBranchName: capsuleSnapshots.sourceBranchName,
        createdAt: capsuleSnapshots.createdAt,
        agentArtifactContentPolicy: capsuleSnapshots.agentArtifactContentPolicy,
      })
      .from(capsuleSnapshots)
      .innerJoin(capsules, and(eq(capsules.id, capsuleSnapshots.capsuleId), eq(capsules.ownerId, ownerId)))
      .innerJoin(
        capsuleSnapshotCaptureOperations,
        and(
          eq(capsuleSnapshotCaptureOperations.snapshotId, capsuleSnapshots.id),
          eq(capsuleSnapshotCaptureOperations.sourceBranchId, capsuleSnapshots.sourceBranchId),
          eq(capsuleSnapshotCaptureOperations.sourceBranchName, capsuleSnapshots.sourceBranchName),
        ),
      )
      .innerJoin(
        capsuleOperations,
        and(
          eq(capsuleOperations.id, capsuleSnapshotCaptureOperations.operationId),
          eq(capsuleOperations.ownerId, ownerId),
          eq(capsuleOperations.capsuleId, capsuleSnapshots.capsuleId),
          eq(capsuleOperations.type, CapsuleOperationType.SNAPSHOT_CAPTURE),
          eq(capsuleOperations.status, CapsuleOperationStatus.COMPLETED),
          isNotNull(capsuleOperations.completedAt),
        ),
      )
      .where(and(eq(capsuleSnapshots.capsuleId, capsuleId), branchCondition, isNull(capsuleSnapshots.archivedAt)))
      .orderBy(desc(capsuleSnapshots.createdAt), desc(capsuleSnapshots.id))
  }

  /**
   * Resolves the source snapshot of one completed fork only when its target
   * branch remains owned by the scoped capsule and is not destroyed.
   */
  public async forkBase(
    ownerId: string,
    capsuleId: string,
    branchId: string,
  ): Promise<CapsuleSnapshotSelectionCandidate | null> {
    const { capsuleBranches, capsuleForkOperations, capsuleOperations, capsuleSnapshots } = this.persistence.tables
    const candidates = await this.persistence.db
      .select({
        id: capsuleSnapshots.id,
        sourceBranchId: capsuleSnapshots.sourceBranchId,
        sourceBranchName: capsuleSnapshots.sourceBranchName,
        createdAt: capsuleSnapshots.createdAt,
        agentArtifactContentPolicy: capsuleSnapshots.agentArtifactContentPolicy,
      })
      .from(capsuleBranches)
      .innerJoin(capsuleForkOperations, eq(capsuleForkOperations.targetBranchId, capsuleBranches.id))
      .innerJoin(
        capsuleOperations,
        and(
          eq(capsuleOperations.id, capsuleForkOperations.operationId),
          eq(capsuleOperations.ownerId, ownerId),
          eq(capsuleOperations.capsuleId, capsuleId),
          eq(capsuleOperations.type, CapsuleOperationType.FORK),
          eq(capsuleOperations.status, CapsuleOperationStatus.COMPLETED),
          isNotNull(capsuleOperations.completedAt),
        ),
      )
      .innerJoin(
        capsuleSnapshots,
        and(
          eq(capsuleSnapshots.id, capsuleForkOperations.sourceSnapshotId),
          eq(capsuleSnapshots.capsuleId, capsuleId),
          isNull(capsuleSnapshots.archivedAt),
        ),
      )
      .where(
        and(
          eq(capsuleBranches.id, branchId),
          eq(capsuleBranches.ownerId, ownerId),
          eq(capsuleBranches.capsuleId, capsuleId),
          ne(capsuleBranches.status, 'destroyed'),
        ),
      )
      .orderBy(desc(capsuleSnapshots.createdAt), desc(capsuleSnapshots.id))
      .limit(2)
    if (candidates.length > 1) {
      throw new IncusError('Selected capsule branch has contradictory completed fork provenance.', 'CONFLICT', {
        ownerId,
        capsuleId,
        branchId,
        candidateSnapshotIds: candidates.map(candidate => candidate.id),
      })
    }
    return candidates[0] ?? null
  }
}
