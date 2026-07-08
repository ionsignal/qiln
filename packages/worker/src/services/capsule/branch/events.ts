import { CapsuleBranchEventName, TargetType, type CapsuleBranchStatus, type CapsuleChannel, type TargetOwner } from '@qiln/core/server'

export class CapsuleBranchEventPublisher {
  constructor(private readonly channel: CapsuleChannel) {}

  public publishStateChanged(ownerId: string, name: string, status: CapsuleBranchStatus): void {
    void this.channel
      .publish(CapsuleBranchEventName.BRANCH_STATE_CHANGED, {
        type: CapsuleBranchEventName.BRANCH_STATE_CHANGED,
        target: this.ownerTarget(ownerId),
        name,
        status,
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Unknown event publishing error'
        console.warn(`[CapsuleBranchRuntimeService] Failed to publish state '${status}' for branch '${name}':`, message)
      })
  }

  public publishDeleted(ownerId: string, name: string): void {
    void this.channel
      .publish(CapsuleBranchEventName.BRANCH_DELETED, {
        type: CapsuleBranchEventName.BRANCH_DELETED,
        target: this.ownerTarget(ownerId),
        name,
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Unknown event publishing error'
        console.warn(`[CapsuleBranchRuntimeService] Failed to publish deletion event for branch '${name}':`, message)
      })
  }

  private ownerTarget(ownerId: string): TargetOwner {
    return {
      type: TargetType.OWNER,
      id: ownerId,
    }
  }
}
