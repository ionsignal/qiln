import { CapsuleBootstrapCommandName, type CapsuleCommandHandlerOptions } from '@qiln/core/server'
import { mapWorkerCapsuleCommandError } from '../../errors'
import type { QilnWorkerRuntime } from '../../../runtime'

/**
 * Registers privileged root capsule bootstrap handlers.
 *
 * Bootstrap is internal lifecycle terminology. Product surfaces should describe
 * this command as creating a capsule, while future branch creation remains
 * reserved for true forks from committed snapshots.
 */
export function registerCapsuleBootstrapHandlers(worker: QilnWorkerRuntime): void {
  const handlerOptions: CapsuleCommandHandlerOptions = {
    mapError: mapWorkerCapsuleCommandError,
  }
  worker.channel.handle(
    CapsuleBootstrapCommandName.BOOTSTRAP_CREATE,
    async input => {
      return await worker.capsule.bootstrap.create({
        ownerId: input.target.id,
        bootstrapBranchName: input.bootstrapBranchName,
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
