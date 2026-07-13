import { and, eq } from 'drizzle-orm'
import {
  CapsuleChannelError,
  CapsuleChannelErrorCode,
  CapsuleSnapshotCommandName,
  TargetType,
  capsulesTable,
  type CapsuleChannel,
  type CapsuleHostDbContract,
  type CapsuleSnapshotListOutput,
  type TargetCapsule,
} from '@qiln/core/server'

/**
 * Public Engine boundary for committed capsule snapshot history.
 *
 * Snapshot commands are capsule-targeted at the protocol layer, so the Engine first proves authenticated
 * ownership without exposing whether a foreign capsule exists. Snapshot capture and physical snapshot
 * mutation remain intentionally outside this read-only service.
 */
export class CapsuleSnapshotService {
  constructor(
    private readonly db: CapsuleHostDbContract,
    private readonly channel: CapsuleChannel,
  ) {}

  public async list(ownerId: string, capsuleId: string): Promise<CapsuleSnapshotListOutput> {
    await this.assertCapsuleOwnership(ownerId, capsuleId)
    return await this.channel.command(CapsuleSnapshotCommandName.SNAPSHOTS_LIST, {
      target: this.capsuleTarget(capsuleId),
    })
  }

  private async assertCapsuleOwnership(ownerId: string, capsuleId: string): Promise<void> {
    const [capsule] = await this.db
      .select({
        id: capsulesTable.id,
      })
      .from(capsulesTable)
      .where(and(eq(capsulesTable.id, capsuleId), eq(capsulesTable.ownerId, ownerId)))
      .limit(1)
    if (!capsule) {
      throw new CapsuleChannelError('Capsule not found or access denied.', {
        code: CapsuleChannelErrorCode.NOT_FOUND,
        details: {
          capsuleId,
        },
      })
    }
  }

  private capsuleTarget(capsuleId: string): TargetCapsule {
    return {
      type: TargetType.CAPSULE,
      id: capsuleId,
    }
  }
}
