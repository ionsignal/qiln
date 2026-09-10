import { CapsuleSnapshotCommandName, type CapsuleCommandHandlerOptions } from '@qiln/core/server'
import { mapWorkerCapsuleCommandError } from '../../errors'
import type { QilnWorkerRuntime } from '../../../runtime'

/**
 * Registers committed snapshot history reads and durable Create Snapshot
 * submission.
 *
 * Mutation receipts prove acceptance or replay. Provider execution continues
 * under the Worker operation supervisor.
 */
export function registerCapsuleSnapshotHandlers(worker: QilnWorkerRuntime): void {
  const handlerOptions: CapsuleCommandHandlerOptions = {
    mapError: mapWorkerCapsuleCommandError,
  }
  worker.channel.handle(
    CapsuleSnapshotCommandName.SNAPSHOTS_LIST,
    async input => {
      return await worker.capsule.snapshot.list(input.target.id, input.capsuleId)
    },
    handlerOptions,
  )
  worker.channel.handle(
    CapsuleSnapshotCommandName.SNAPSHOT_CREATE,
    async input => {
      return await worker.capsule.createSnapshot.submit({
        ownerId: input.target.id,
        actor: input.actor,
        capsuleId: input.capsuleId,
        sourceBranchId: input.sourceBranchId,
        idempotencyKey: input.idempotencyKey,
      })
    },
    handlerOptions,
  )
}
