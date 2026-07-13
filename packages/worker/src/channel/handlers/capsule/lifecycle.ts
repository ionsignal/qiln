import { CapsuleLifecycleCommandName, type CapsuleCommandHandlerOptions } from '@qiln/core/server'
import { mapWorkerCapsuleCommandError } from '../../errors'
import type { QilnWorkerRuntime } from '../../../runtime'

/**
 * Registers capsule-level logical lifecycle and terminal retirement handlers.
 *
 * Archive and unarchive are reversible logical changes. Destroy is the terminal,
 * provider-aware retirement flow and remains separate from branch runtime
 * start/stop behavior.
 */
export function registerCapsuleLifecycleHandlers(worker: QilnWorkerRuntime): void {
  const handlerOptions: CapsuleCommandHandlerOptions = {
    mapError: mapWorkerCapsuleCommandError,
  }

  worker.channel.handle(
    CapsuleLifecycleCommandName.CAPSULE_ARCHIVE,
    async input => {
      return await worker.capsule.lifecycle.archive({
        ownerId: input.target.id,
        capsuleId: input.capsuleId,
        idempotencyKey: input.idempotencyKey,
      })
    },
    handlerOptions,
  )

  worker.channel.handle(
    CapsuleLifecycleCommandName.CAPSULE_UNARCHIVE,
    async input => {
      return await worker.capsule.lifecycle.unarchive({
        ownerId: input.target.id,
        capsuleId: input.capsuleId,
        idempotencyKey: input.idempotencyKey,
      })
    },
    handlerOptions,
  )

  worker.channel.handle(
    CapsuleLifecycleCommandName.CAPSULE_DESTROY,
    async input => {
      return await worker.capsule.lifecycle.destroy({
        ownerId: input.target.id,
        capsuleId: input.capsuleId,
        idempotencyKey: input.idempotencyKey,
      })
    },
    handlerOptions,
  )
}
