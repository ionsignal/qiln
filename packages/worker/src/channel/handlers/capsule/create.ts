import { CapsuleCreateCommandName, type CapsuleCommandHandlerOptions } from '@qiln/core/server'
import { mapWorkerCapsuleCommandError } from '../../errors'
import type { QilnWorkerRuntime } from '../../../runtime'

/**
 * Registers durable capsule-create submission.
 *
 * The operation service returns after durable acceptance or idempotent replay.
 * Provider execution remains supervised and asynchronous.
 */
export function registerCapsuleCreateHandler(worker: QilnWorkerRuntime): void {
  const handlerOptions: CapsuleCommandHandlerOptions = {
    mapError: mapWorkerCapsuleCommandError,
  }
  worker.channel.handle(
    CapsuleCreateCommandName.CAPSULE_CREATE,
    async input => {
      return await worker.capsule.create.submit({
        ownerId: input.target.id,
        actor: input.actor,
        rootBranchName: input.rootBranchName,
        idempotencyKey: input.idempotencyKey,
        blueprintName: input.blueprintName,
        blueprintDigest: input.blueprintDigest,
        cpu: input.cpu,
        memory: input.memory,
      })
    },
    handlerOptions,
  )
}
