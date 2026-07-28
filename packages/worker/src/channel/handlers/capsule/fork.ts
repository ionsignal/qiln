import { CapsuleForkCommandName, type CapsuleCommandHandlerOptions } from '@qiln/core/server'
import { mapWorkerCapsuleCommandError } from '../../errors'
import type { QilnWorkerRuntime } from '../../../runtime'

/**
 * Registers durable experimental snapshot-fork submission.
 *
 * The handler returns after acceptance or replay. Provider materialization
 * continues under the Worker operation supervisor.
 */
export function registerCapsuleForkHandler(worker: QilnWorkerRuntime): void {
  const handlerOptions: CapsuleCommandHandlerOptions = {
    mapError: mapWorkerCapsuleCommandError,
  }
  worker.channel.handle(
    CapsuleForkCommandName.CAPSULE_FORK,
    async input => {
      return await worker.capsule.fork.submit({
        ownerId: input.target.id,
        actor: input.actor,
        capsuleId: input.capsuleId,
        sourceSnapshotId: input.sourceSnapshotId,
        branchName: input.branchName,
        idempotencyKey: input.idempotencyKey,
        cpu: input.cpu,
        memory: input.memory,
      })
    },
    handlerOptions,
  )
}
