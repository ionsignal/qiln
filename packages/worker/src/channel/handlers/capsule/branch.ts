import { CapsuleBranchCommandName, type CapsuleCommandHandlerOptions } from '@qiln/core/server'
import { mapWorkerCapsuleCommandError } from '../../errors'
import type { QilnWorkerRuntime } from '../../../runtime'

/**
 * Registers privileged runtime handlers for existing editable capsule branches.
 *
 * Direct branch deletion is intentionally unavailable. Capsule archive and
 * destroy govern retirement of the bootstrap lineage root.
 */
export function registerCapsuleBranchHandlers(worker: QilnWorkerRuntime): void {
  const handlerOptions: CapsuleCommandHandlerOptions = {
    mapError: mapWorkerCapsuleCommandError,
  }
  worker.channel.handle(
    CapsuleBranchCommandName.BRANCH_START,
    async input => {
      return await worker.capsule.branch.start(input.target.id, input.capsuleId, input.name)
    },
    handlerOptions,
  )
  worker.channel.handle(
    CapsuleBranchCommandName.BRANCH_STOP,
    async input => {
      return await worker.capsule.branch.stop(input.target.id, input.capsuleId, input.name)
    },
    handlerOptions,
  )
}
