import { CapsuleRouteEventName, TargetType, type CapsuleChannel } from '@qiln/core/server'
import type { CommittedRouteState } from '../routing'

/**
 * Publishes best-effort invalidation hints for committed route state.
 *
 * Consumers must refetch PostgreSQL-authoritative committed alias state.
 */
export class CapsuleRouteEventPublisher {
  constructor(private readonly channel: CapsuleChannel) {}

  public changed(ownerId: string, route: CommittedRouteState): void {
    void this.channel
      .publish(CapsuleRouteEventName.ROUTE_CHANGED, {
        type: CapsuleRouteEventName.ROUTE_CHANGED,
        target: {
          type: TargetType.OWNER,
          id: ownerId,
        },
        capsuleId: route.capsuleId,
        aliasId: route.aliasId,
        aliasName: route.aliasName,
        aliasStatus: route.aliasStatus,
        currentRevisionId: route.currentRevisionId,
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Unknown route event publishing error'
        console.warn(
          `[CapsuleRouteEventPublisher] Failed to publish committed route state for alias '${route.aliasId}':`,
          message,
        )
      })
  }
}
