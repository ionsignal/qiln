import { CapsuleBranchCommandName, type CapsuleCommandHandlerOptions } from '@qiln/core/server'
import { mapWorkerCapsuleCommandError } from '../../errors'
import type { QilnWorkerRuntime } from '../../../runtime'

/**
 * Registers durable start and stop submissions for existing editable capsule
 * branches.
 *
 * Handlers return acceptance or replay receipts without waiting for runtime,
 * SSH, or preview coordination. Actor provenance and idempotency keys pass
 * through unchanged from the validated command.
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
      return await worker.capsule.start.submit({
        ownerId: input.target.id,
        actor: input.actor,
        capsuleId: input.capsuleId,
        branchId: input.branchId,
        idempotencyKey: input.idempotencyKey,
      })
    },
    handlerOptions,
  )
  worker.channel.handle(
    CapsuleBranchCommandName.BRANCH_STOP,
    async input => {
      return await worker.capsule.stop.submit({
        ownerId: input.target.id,
        actor: input.actor,
        capsuleId: input.capsuleId,
        branchId: input.branchId,
        idempotencyKey: input.idempotencyKey,
      })
    },
    handlerOptions,
  )
}
