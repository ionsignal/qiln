import { CapsuleOperationEventName, TargetType, type CapsuleChannel } from '@qiln/core/server'
import type { CapsuleOperationTransitionOutput } from '../operations/shared/types'

/**
 * Publishes best-effort invalidation hints for committed capsule operation
 * transitions.
 *
 * The transition must come from committed repository output or a fresh durable
 * read after commit. The publisher deliberately accepts no operation-specific
 * domain references, provider data, failure diagnostics, request context, or
 * original command payload.
 *
 * Consumers must refetch PostgreSQL-authoritative operation state after
 * receiving an event. Event delivery and ordering are not guaranteed.
 */
export class CapsuleOperationEventPublisher {
  constructor(private readonly channel: CapsuleChannel) {}

  public publishChanged(operation: CapsuleOperationTransitionOutput): void {
    void this.channel
      .publish(CapsuleOperationEventName.OPERATION_CHANGED, {
        type: CapsuleOperationEventName.OPERATION_CHANGED,
        target: {
          type: TargetType.OWNER,
          id: operation.ownerId,
        },
        operationId: operation.operationId,
        operationType: operation.operationType,
        operationStatus: operation.operationStatus,
        capsuleId: operation.capsuleId,
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Unknown operation event publishing error'
        console.warn(
          `[CapsuleOperationEventPublisher] Failed to publish committed operation '${operation.operationId}' status '${operation.operationStatus}':`,
          message,
        )
      })
  }
}
