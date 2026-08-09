import { AgentContextSnapshotSchema, type AgentContextSnapshot, type AgentSnapshotSelection } from '@qiln/core/server'
import { IncusError } from '../../../errors'
import type { CapsuleSnapshotArtifactStore } from './artifact'
import type { CapsuleSnapshotStore } from './store'
import type { CapsuleSnapshotSelectionCandidate } from './types'

/**
 * Resolves one immutable, manifest-readable snapshot reference for an
 * authenticated agent context.
 *
 * Selection never persists a mutable latest pointer, reserves a snapshot,
 * mutates capsule state, changes branch state, or reads provider storage. Each
 * returned ID remains an exact immutable snapshot reference even when a later
 * selection returns a newer snapshot.
 */
export class CapsuleSnapshotSelector {
  constructor(
    private readonly snapshots: CapsuleSnapshotStore,
    private readonly artifacts: CapsuleSnapshotArtifactStore,
  ) {}

  public async select(
    ownerId: string,
    capsuleId: string,
    selectedBranchId?: string,
  ): Promise<AgentContextSnapshot | null> {
    if (selectedBranchId === undefined) {
      return await this.firstManifestReadable(
        ownerId,
        capsuleId,
        await this.snapshots.candidates(ownerId, capsuleId),
        'capsule_latest',
      )
    }
    const branchCapture = await this.firstManifestReadable(
      ownerId,
      capsuleId,
      await this.snapshots.candidates(ownerId, capsuleId, selectedBranchId),
      'branch_latest',
    )
    if (branchCapture !== null) {
      return branchCapture
    }
    const forkBase = await this.snapshots.forkBase(ownerId, capsuleId, selectedBranchId)
    if (forkBase === null) {
      return null
    }
    try {
      return await this.toContextSnapshot(ownerId, capsuleId, forkBase, 'fork_base')
    } catch (error: unknown) {
      if (this.isUnreadableSnapshotEvidence(error)) {
        return null
      }
      throw error
    }
  }

  private async firstManifestReadable(
    ownerId: string,
    capsuleId: string,
    candidates: readonly CapsuleSnapshotSelectionCandidate[],
    selection: AgentSnapshotSelection,
  ): Promise<AgentContextSnapshot | null> {
    for (const candidate of candidates) {
      try {
        return await this.toContextSnapshot(ownerId, capsuleId, candidate, selection)
      } catch (error: unknown) {
        if (this.isUnreadableSnapshotEvidence(error)) {
          continue
        }
        throw error
      }
    }
    return null
  }

  private async toContextSnapshot(
    ownerId: string,
    capsuleId: string,
    candidate: CapsuleSnapshotSelectionCandidate,
    selection: AgentSnapshotSelection,
  ): Promise<AgentContextSnapshot> {
    const artifacts = await this.artifacts.load(ownerId, capsuleId, candidate.id)
    if (candidate.agentArtifactContentPolicy !== artifacts.agentArtifactContentPolicy) {
      throw new IncusError('Committed snapshot context policy evidence is inconsistent.', 'CONFLICT', {
        snapshotId: candidate.id,
        candidateAgentArtifactContentPolicy: candidate.agentArtifactContentPolicy,
        validatedAgentArtifactContentPolicy: artifacts.agentArtifactContentPolicy,
      })
    }
    try {
      return AgentContextSnapshotSchema.parse({
        id: candidate.id,
        sourceBranchId: candidate.sourceBranchId,
        sourceBranchName: candidate.sourceBranchName,
        createdAt: this.toTimestamp(candidate),
        selection,
        artifactManifest: {
          schemaVersion: artifacts.manifestSchemaVersion,
          digest: artifacts.manifestDigest,
        },
        agentArtifactContentPolicy: artifacts.agentArtifactContentPolicy,
      })
    } catch (error: unknown) {
      throw new IncusError('Committed snapshot context evidence is invalid.', 'CONFLICT', {
        snapshotId: candidate.id,
        reason: error instanceof Error ? error.message : 'Unknown snapshot context validation failure.',
      })
    }
  }

  private toTimestamp(candidate: CapsuleSnapshotSelectionCandidate): string {
    if (!(candidate.createdAt instanceof Date) || !Number.isFinite(candidate.createdAt.getTime())) {
      throw new IncusError('Committed snapshot has an invalid creation timestamp.', 'CONFLICT', {
        snapshotId: candidate.id,
      })
    }
    return candidate.createdAt.toISOString()
  }

  private isUnreadableSnapshotEvidence(error: unknown): boolean {
    return error instanceof IncusError && (error.code === 'NOT_FOUND' || error.code === 'CONFLICT')
  }
}
