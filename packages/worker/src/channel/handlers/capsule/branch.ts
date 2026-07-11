import { CapsuleBranchCommandName, type CapsuleCommandHandlerOptions } from '@qiln/core/server'
import { mapWorkerCapsuleCommandError } from '../../errors'
import type { QilnWorkerRuntime } from '../../../runtime'

/**
 * Registers privileged capsule branch lifecycle handlers.
 *
 * The Capsule Channel validates command input/output and subject targets before
 * these handlers run. The worker only performs Incus/ZFS/Postgres side effects.
 */
export function registerCapsuleBranchHandlers(worker: QilnWorkerRuntime): void {
  const handlerOptions: CapsuleCommandHandlerOptions = {
    mapError: mapWorkerCapsuleCommandError,
  }
  worker.channel.handle(
    CapsuleBranchCommandName.BRANCH_CREATE,
    async input => {
      return await worker.capsule.create(
        input.target.id,
        input.name,
        input.blueprintName,
        input.blueprintDigest,
        input.idempotencyKey,
        input.cpu,
        input.memory,
      )
    },
    handlerOptions,
  )
  worker.channel.handle(
    CapsuleBranchCommandName.BRANCH_START,
    async input => {
      return await worker.capsule.start(input.target.id, input.name)
    },
    handlerOptions,
  )
  worker.channel.handle(
    CapsuleBranchCommandName.BRANCH_STOP,
    async input => {
      return await worker.capsule.stop(input.target.id, input.name)
    },
    handlerOptions,
  )
  worker.channel.handle(
    CapsuleBranchCommandName.BRANCH_DELETE,
    async input => {
      return await worker.capsule.delete(input.target.id, input.name, input.idempotencyKey)
    },
    handlerOptions,
  )
}
