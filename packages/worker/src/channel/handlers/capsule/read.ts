import { CapsuleReadCommandName, type CapsuleCommandHandlerOptions } from '@qiln/core/server'
import { mapWorkerCapsuleCommandError } from '../../errors'
import type { QilnWorkerRuntime } from '../../../runtime'

/**
 * Owner targets are supplied by the trusted authenticated publisher.
 * Projections remain Worker-owned and never perform live provider reads.
 */
export function registerCapsuleReadHandlers(worker: QilnWorkerRuntime): void {
  const options: CapsuleCommandHandlerOptions = {
    mapError: mapWorkerCapsuleCommandError,
  }
  worker.channel.handle(
    CapsuleReadCommandName.CAPSULE_LIST,
    async input => {
      return await worker.capsule.read.list(input.target.id)
    },
    options,
  )
  worker.channel.handle(
    CapsuleReadCommandName.CAPSULE_DETAIL,
    async input => {
      return await worker.capsule.read.detail(input.target.id, input.capsuleId, input.branchId)
    },
    options,
  )
}
