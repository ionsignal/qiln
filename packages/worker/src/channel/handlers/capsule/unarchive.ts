import { CapsuleOperationCommandName, type CapsuleCommandHandlerOptions } from '@qiln/core/server'
import { mapWorkerCapsuleCommandError } from '../../errors'
import type { QilnWorkerRuntime } from '../../../runtime'

/**
 * Registers durable capsule-unarchive submission.
 *
 * Successful submission does not imply that the asynchronous operation has
 * completed or that the capsule archive timestamp has been cleared.
 */
export function registerCapsuleUnarchiveHandler(worker: QilnWorkerRuntime): void {
  const handlerOptions: CapsuleCommandHandlerOptions = {
    mapError: mapWorkerCapsuleCommandError,
  }
  worker.channel.handle(
    CapsuleOperationCommandName.CAPSULE_UNARCHIVE,
    async input => {
      return await worker.capsule.unarchive.submit({
        ownerId: input.target.id,
        capsuleId: input.capsuleId,
        idempotencyKey: input.idempotencyKey,
      })
    },
    handlerOptions,
  )
}
