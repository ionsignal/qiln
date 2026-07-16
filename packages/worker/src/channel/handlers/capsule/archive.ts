import { CapsuleOperationCommandName, type CapsuleCommandHandlerOptions } from '@qiln/core/server'
import { mapWorkerCapsuleCommandError } from '../../errors'
import type { QilnWorkerRuntime } from '../../../runtime'

/**
 * Registers durable capsule-archive submission.
 *
 * Archive execution is supervised even though it performs no provider work.
 */
export function registerCapsuleArchiveHandler(worker: QilnWorkerRuntime): void {
  const handlerOptions: CapsuleCommandHandlerOptions = {
    mapError: mapWorkerCapsuleCommandError,
  }
  worker.channel.handle(
    CapsuleOperationCommandName.CAPSULE_ARCHIVE,
    async input => {
      return await worker.capsule.archive.submit({
        ownerId: input.target.id,
        capsuleId: input.capsuleId,
        idempotencyKey: input.idempotencyKey,
      })
    },
    handlerOptions,
  )
}
