import { CapsuleLifecycleCommandName, type CapsuleCommandHandlerOptions } from '@qiln/core/server'
import { mapWorkerCapsuleCommandError } from '../../../errors'
import type { QilnWorkerRuntime } from '../../../../runtime'

/**
 * Registers durable capsule-destroy submission.
 *
 * The handler returns the durable operation receipt without waiting for
 * provider deletion or terminal aggregate completion.
 */
export function registerCapsuleLifecycleDestroyHandler(worker: QilnWorkerRuntime): void {
  const handlerOptions: CapsuleCommandHandlerOptions = {
    mapError: mapWorkerCapsuleCommandError,
  }
  worker.channel.handle(
    CapsuleLifecycleCommandName.CAPSULE_DESTROY,
    async input => {
      return await worker.capsule.destroy.submit({
        ownerId: input.target.id,
        actor: input.actor,
        capsuleId: input.capsuleId,
        idempotencyKey: input.idempotencyKey,
      })
    },
    handlerOptions,
  )
}
