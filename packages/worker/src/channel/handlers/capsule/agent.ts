import { CapsuleAgentReadCommandName, type CapsuleCommandHandlerOptions } from '@qiln/core/server'
import { mapWorkerCapsuleCommandError } from '../../errors'
import type { QilnWorkerRuntime } from '../../../runtime'

/**
 * Registers immutable committed snapshot reads for authenticated external
 * agents. The host derives credential authority before publishing this command;
 * the Worker independently proves committed snapshot lineage.
 */
export function registerCapsuleAgentReadHandler(worker: QilnWorkerRuntime): void {
  const handlerOptions: CapsuleCommandHandlerOptions = {
    mapError: mapWorkerCapsuleCommandError,
  }

  worker.channel.handle(
    CapsuleAgentReadCommandName.AGENT_READ,
    async input => {
      return await worker.capsule.snapshot.read(input.target.id, input.capsuleId, input.read)
    },
    handlerOptions,
  )
}
