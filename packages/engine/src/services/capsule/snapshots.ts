import { and, eq } from 'drizzle-orm'
import {
  CapsuleSnapshotCaptureOutputSchema,
  CapsuleSnapshotCommandName,
  CapsuleSnapshotListOutputSchema,
  GlobalError,
  GlobalErrorCode,
  TargetType,
  type CapsuleChannel,
  type CapsuleOperationIdempotencyKey,
  type CapsuleSnapshotAgentArtifactContentPolicyValue,
  type CapsuleSnapshotCaptureOutput,
  type CapsuleSnapshotListOutput,
} from '@qiln/core/server'
import type { EnginePersistence } from '../../persistence'
import type { CapsuleMutationIdentity } from './types'

export interface CapsuleSnapshotListOptions {
  includeExperimental?: boolean
}

export interface CapsuleSnapshotCaptureRequest {
  capsuleId: string
  sourceBranchId: string
  idempotencyKey: CapsuleOperationIdempotencyKey
  agentArtifactContentPolicy: CapsuleSnapshotAgentArtifactContentPolicyValue
}

/**
 * Public Engine boundary for committed capsule snapshot history and Snapshot
 * Capture submission.
 *
 * Snapshot commands are owner-targeted at the protocol layer. The Engine
 * derives owner and actor authority from authenticated context and proves local
 * capsule visibility before dispatch. The Worker independently verifies durable
 * ownership, aggregate state, source-branch eligibility, capture-policy
 * evidence, and the capsule-wide nonterminal-operation fence.
 *
 * Capture returns only a durable acceptance or replay receipt. It does not wait
 * for provider snapshot creation, artifact collection, atomic snapshot commit,
 * or branch restoration.
 */
export class CapsuleSnapshotsService {
  constructor(
    private readonly persistence: EnginePersistence,
    private readonly channel: CapsuleChannel,
  ) {}

  public async list(
    ownerId: string,
    capsuleId: string,
    options: CapsuleSnapshotListOptions = {},
  ): Promise<CapsuleSnapshotListOutput> {
    await this.assertOwnedCapsule(ownerId, capsuleId)
    const snapshots = await this.channel.command(CapsuleSnapshotCommandName.SNAPSHOTS_LIST, {
      target: {
        type: TargetType.OWNER,
        id: ownerId,
      },
      capsuleId,
      includeExperimental: options.includeExperimental ?? false,
    })
    return CapsuleSnapshotListOutputSchema.parse(snapshots)
  }

  /**
   * Submits an experimental Snapshot Capture operation using authenticated
   * owner and actor authority.
   *
   * Browser input supplies only domain identity, idempotency, and the immutable
   * agent artifact-content policy. Capture mode, owner target, actor
   * provenance, provider identities, and all mutation fences remain trusted
   * server-side concerns.
   */
  public async capture(
    identity: CapsuleMutationIdentity,
    input: CapsuleSnapshotCaptureRequest,
  ): Promise<CapsuleSnapshotCaptureOutput> {
    await this.assertOwnedCapsule(identity.ownerId, input.capsuleId)
    const receipt = await this.channel.command(CapsuleSnapshotCommandName.SNAPSHOT_CAPTURE, {
      target: {
        type: TargetType.OWNER,
        id: identity.ownerId,
      },
      actor: identity.actor,
      capsuleId: input.capsuleId,
      sourceBranchId: input.sourceBranchId,
      idempotencyKey: input.idempotencyKey,
      agentArtifactContentPolicy: input.agentArtifactContentPolicy,
    })
    return CapsuleSnapshotCaptureOutputSchema.parse(receipt)
  }

  /**
   * Provides defense in depth at the authenticated Engine boundary.
   *
   * Missing and foreign capsules are intentionally indistinguishable. The
   * Worker remains authoritative and repeats this ownership proof before
   * validating snapshot reads or accepting Snapshot Capture.
   */
  private async assertOwnedCapsule(ownerId: string, capsuleId: string): Promise<void> {
    const { db, tables } = this.persistence
    const capsules = tables.capsules
    const [capsule] = await db
      .select({
        id: capsules.id,
      })
      .from(capsules)
      .where(and(eq(capsules.id, capsuleId), eq(capsules.ownerId, ownerId)))
      .limit(1)
    if (!capsule) {
      throw new GlobalError('Capsule not found or access denied.', GlobalErrorCode.NOT_FOUND, {
        capsuleId,
      })
    }
  }
}
