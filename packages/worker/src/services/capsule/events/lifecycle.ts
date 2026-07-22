import {
  CapsuleLifecycleEventName,
  TargetType,
  type CapsuleChannel,
  type CapsuleLifecycleState,
} from '@qiln/core/server'

/**
 * Publishes best-effort invalidation hints for committed capsule aggregate
 * lifecycle changes.
 *
 * Callers must supply lifecycle state returned by an operation-specific
 * repository transaction or by a fresh durable read after commit. This
 * publisher does not reconstruct aggregate state from command input, executor
 * assumptions, or provider observations.
 *
 * Consumers must refetch PostgreSQL-authoritative capsule state after receiving
 * an event. Event delivery and ordering are not guaranteed.
 */
export class CapsuleLifecycleEventPublisher {
  constructor(private readonly channel: CapsuleChannel) {}

  public publishChanged(ownerId: string, state: CapsuleLifecycleState): void {
    void this.channel
      .publish(CapsuleLifecycleEventName.LIFECYCLE_CHANGED, {
        type: CapsuleLifecycleEventName.LIFECYCLE_CHANGED,
        target: {
          type: TargetType.OWNER,
          id: ownerId,
        },
        capsuleId: state.capsuleId,
        lifecycleStatus: state.lifecycleStatus,
        archivedAt: state.archivedAt,
        destroyedAt: state.destroyedAt,
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Unknown capsule lifecycle event publishing error'

        console.warn(
          `[CapsuleLifecycleEventPublisher] Failed to publish committed lifecycle '${state.lifecycleStatus}' for capsule '${state.capsuleId}':`,
          message,
        )
      })
  }
}
