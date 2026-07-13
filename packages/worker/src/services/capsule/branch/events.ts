import { CapsuleBranchEventName, TargetType, type CapsuleBranchStatus, type CapsuleChannel, type TargetOwner } from '@qiln/core/server'

export class CapsuleBranchEventPublisher {
  constructor(private readonly channel: CapsuleChannel) {}

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
        const message = error instanceof Error ? error.message : 'Unknown event publishing error'
        console.warn(`[CapsuleBranchEventPublisher] Failed to publish state '${status}' for capsule '${capsuleId}' branch '${name}':`, message)
      })
  }

  private ownerTarget(ownerId: string): TargetOwner {
    return {
      type: TargetType.OWNER,
      id: ownerId,
    }
  }
}
