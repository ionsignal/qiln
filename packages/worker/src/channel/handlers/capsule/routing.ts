import { CapsuleRouteCommandName, type CapsuleCommandHandlerOptions } from '@qiln/core/server'
import { mapWorkerCapsuleCommandError } from '../../errors'
import type { QilnWorkerRuntime } from '../../../runtime'

/**
 * Registers PostgreSQL-authoritative committed route reads.
 *
 * Promote and rollback commands remain unavailable until acceptance policy,
 * actor separation, Caddy application, verification, and finalization exist.
 */
export function registerCapsuleRouteHandlers(worker: QilnWorkerRuntime): void {
  const handlerOptions: CapsuleCommandHandlerOptions = {
    mapError: mapWorkerCapsuleCommandError,
  }
  worker.channel.handle(
    CapsuleRouteCommandName.ROUTES_LIST,
    async input => {
      return await worker.capsule.route.list(input.target.id, input.capsuleId)
    },
    handlerOptions,
  )
}
