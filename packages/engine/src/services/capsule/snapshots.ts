import { and, eq } from 'drizzle-orm'
import {
  CapsuleSnapshotCreateOutputSchema,
  CapsuleSnapshotCommandName,
  CapsuleSnapshotListOutputSchema,
  GlobalError,
  GlobalErrorCode,
  TargetType,
  type CapsuleChannel,
  type CapsuleOperationIdempotencyKey,
  type CapsuleSnapshotCreateOutput,
  type CapsuleSnapshotListOutput,
} from '@qiln/core/server'
import type { EnginePersistence } from '../../persistence'
import type { CapsuleMutationIdentity } from './types'

export interface CapsuleSnapshotCreateRequest {
  capsuleId: string
  sourceBranchId: string
  idempotencyKey: CapsuleOperationIdempotencyKey
}

/**
 * Public Engine boundary for committed capsule snapshot history and Create
 * Snapshot submission.
 *
 * Snapshot commands are owner-targeted at the protocol layer. The Engine
 * derives owner and actor authority from authenticated context and proves local
 * capsule visibility before dispatch. The Worker independently verifies durable
 * ownership, aggregate state, offline source-branch eligibility, restoration
 * evidence, and the capsule-wide nonterminal-operation fence.
 *
 * Create returns only a durable acceptance or replay receipt. It does not wait
 * for managed-volume provider snapshots or the atomic commit of complete
 * restoration evidence.
 */
export class CapsuleSnapshotsService {
  constructor(
    private readonly persistence: EnginePersistence,
    private readonly channel: CapsuleChannel,
  ) {}

  public async list(ownerId: string, capsuleId: string): Promise<CapsuleSnapshotListOutput> {
    await this.assertOwnedCapsule(ownerId, capsuleId)
    const snapshots = await this.channel.command(CapsuleSnapshotCommandName.SNAPSHOTS_LIST, {
      target: {
        type: TargetType.OWNER,
        id: ownerId,
      },
      capsuleId,
    })
    return CapsuleSnapshotListOutputSchema.parse(snapshots)
  }

  /**
   * Submits Create Snapshot using authenticated owner and actor authority.
   *
   * Browser input supplies only domain identity and idempotency. Owner target,
   * actor provenance, provider identities, restoration pins, and all mutation
   * fences remain trusted server-side concerns.
   */
  public async create(
    identity: CapsuleMutationIdentity,
    input: CapsuleSnapshotCreateRequest,
  ): Promise<CapsuleSnapshotCreateOutput> {
    await this.assertOwnedCapsule(identity.ownerId, input.capsuleId)
    const receipt = await this.channel.command(CapsuleSnapshotCommandName.SNAPSHOT_CREATE, {
      target: {
        type: TargetType.OWNER,
        id: identity.ownerId,
      },
      actor: identity.actor,
      capsuleId: input.capsuleId,
      sourceBranchId: input.sourceBranchId,
      idempotencyKey: input.idempotencyKey,
    })
    return CapsuleSnapshotCreateOutputSchema.parse(receipt)
  }

  /**
   * Provides defense in depth at the authenticated Engine boundary.
   *
   * Missing and foreign capsules are intentionally indistinguishable. The
   * Worker remains authoritative and repeats this ownership proof before
   * validating snapshot reads or accepting Create Snapshot.
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
