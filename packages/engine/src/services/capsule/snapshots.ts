import { and, eq } from 'drizzle-orm'
import {
  CapsuleSnapshotCommandName,
  GlobalError,
  GlobalErrorCode,
  TargetType,
  capsulesTable,
  type CapsuleChannel,
  type CapsuleHostDbContract,
  type CapsuleSnapshotListOutput,
} from '@qiln/core/server'

/**
 * Public Engine boundary for committed capsule snapshot history.
 *
 * Snapshot commands are owner-targeted at the protocol layer. The Engine
 * derives that target from authenticated context and proves local visibility
 * before dispatch. The Worker independently verifies durable ownership before
 * reading snapshot history.
 *
 * Snapshot capture and physical snapshot mutation remain intentionally outside
 * this read-only service.
 */
export class CapsuleSnapshotsService {
  constructor(
    private readonly db: CapsuleHostDbContract,
    private readonly channel: CapsuleChannel,
  ) {}

  public async list(ownerId: string, capsuleId: string): Promise<CapsuleSnapshotListOutput> {
    await this.assertOwnedCapsule(ownerId, capsuleId)
    return await this.channel.command(CapsuleSnapshotCommandName.SNAPSHOTS_LIST, {
      target: {
        type: TargetType.OWNER,
        id: ownerId,
      },
      capsuleId,
    })
  }

  /**
   * Provides defense in depth at the authenticated Engine boundary.
   *
   * The Worker remains authoritative and repeats this ownership proof before
   * reading durable snapshot state.
   */
  private async assertOwnedCapsule(ownerId: string, capsuleId: string): Promise<void> {
    const [capsule] = await this.db
      .select({
        id: capsulesTable.id,
      })
      .from(capsulesTable)
      .where(and(eq(capsulesTable.id, capsuleId), eq(capsulesTable.ownerId, ownerId)))
      .limit(1)
    if (!capsule) {
      throw new GlobalError('Capsule not found or access denied.', GlobalErrorCode.NOT_FOUND, {
        capsuleId,
      })
    }
  }
}
