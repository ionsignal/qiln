import { CapsuleBranchEventName, TargetType, type CapsuleBranchStatus, type CapsuleChannel, type TargetOwner } from '@qiln/core/server'

export interface CommittedCapsuleBranchStateResult {
  branchName: string
  status: CapsuleBranchStatus
  statusChanged: boolean
}

/**
 * Publishes best-effort invalidation hints for committed capsule branch state
 * changes.
 *
 * Operation callers must pass branch state returned by committed repository
 * output. The branch runtime service and reconciler publish only after their
 * branch-state transactions complete.
 *
 * Consumers must refetch PostgreSQL-authoritative branch state after receiving
 * an event. Event delivery and ordering are not guaranteed.
 */
export class CapsuleBranchEventPublisher {
  constructor(private readonly channel: CapsuleChannel) {}

  /**
   * Publishes a known committed branch transition.
   *
   * This remains available for operation repositories whose committed result
   * already proves that a transition occurred.
   */
  public publishStateChanged(ownerId: string, capsuleId: string, name: string, status: CapsuleBranchStatus): void {
    void this.channel
      .publish(CapsuleBranchEventName.BRANCH_STATE_CHANGED, {
        type: CapsuleBranchEventName.BRANCH_STATE_CHANGED,
        target: this.ownerTarget(ownerId),
        capsuleId,
        name,
        status,
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Unknown branch event publishing error'
        console.warn(
          `[CapsuleBranchEventPublisher] Failed to publish committed state '${status}' for capsule '${capsuleId}' branch '${name}':`,
          message,
        )
      })
  }

  /**
   * Publishes only when a committed store result proves the durable status
   * changed.
   *
   * This keeps event gating mechanical while requiring callers to supply the
   * result returned by a completed PostgreSQL state transition.
   */
  public publishCommittedState(ownerId: string, capsuleId: string, result: CommittedCapsuleBranchStateResult): void {
    if (!result.statusChanged) {
      return
    }
    this.publishStateChanged(ownerId, capsuleId, result.branchName, result.status)
  }

  private ownerTarget(ownerId: string): TargetOwner {
    return {
      type: TargetType.OWNER,
      id: ownerId,
    }
  }
}
