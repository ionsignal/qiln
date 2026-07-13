import { CapsuleLifecycleEventName, TargetType, type CapsuleChannel, type CapsuleLifecycleState, type TargetOwner } from '@qiln/core/server'

/**
 * TODO(lifecycle-events): Complete publication coverage for every committed
 * capsule lifecycle transition.
 *
 * Archive, unarchive, and successful destroy currently publish lifecycle
 * changes, but the following durable transitions still need publication:
 *
 * - bootstrap finalized: active
 * - fully compensated bootstrap failure: creation_failed
 * - bootstrap uncertainty or cleanup failure: cleanup_required
 * - abandoned bootstrap startup sweep: cleanup_required
 * - destroy accepted: destroying
 * - destroy failure: cleanup_required
 * - abandoned destroy startup sweep: cleanup_required
 *
 * Publish only after the corresponding database transaction commits, and use
 * the committed client-safe lifecycle state returned by the persistence
 * boundary rather than reconstructing state at the call site. Bootstrap will
 * also need CapsuleLifecycleEventPublisher added to its composed dependencies.
 *
 * Publication remains best-effort after commit. Guaranteed delivery through a
 * transactional outbox is separate future work.
 */
export class CapsuleLifecycleEventPublisher {
  constructor(private readonly channel: CapsuleChannel) {}

  public publishChanged(ownerId: string, state: CapsuleLifecycleState): void {
    void this.channel
      .publish(CapsuleLifecycleEventName.LIFECYCLE_CHANGED, {
        type: CapsuleLifecycleEventName.LIFECYCLE_CHANGED,
        target: this.ownerTarget(ownerId),
        ...state,
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Unknown event publishing error'
        console.warn(
          `[CapsuleLifecycleEventPublisher] Failed to publish lifecycle '${state.lifecycleStatus}' for capsule '${state.capsuleId}':`,
          message,
        )
      })
  }

  private ownerTarget(ownerId: string): TargetOwner {
    return {
      type: TargetType.OWNER,
      id: ownerId,
    }
  }
}
