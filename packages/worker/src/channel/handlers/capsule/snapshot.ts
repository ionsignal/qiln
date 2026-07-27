import { CapsuleSnapshotCommandName, type CapsuleCommandHandlerOptions } from '@qiln/core/server'
import { mapWorkerCapsuleCommandError } from '../../errors'
import type { QilnWorkerRuntime } from '../../../runtime'

/**
 * Registers committed snapshot history reads and experimental Snapshot Capture
 * submission.
 *
 * Capture execution remains disabled by default through Worker configuration.
 * The command may be registered while disabled because the Worker-owned
 * submission boundary rejects acceptance before any operation, branch fence,
 * provider intent, or provider mutation is created.
 */
export function registerCapsuleSnapshotHandlers(worker: QilnWorkerRuntime): void {
  const handlerOptions: CapsuleCommandHandlerOptions = {
    mapError: mapWorkerCapsuleCommandError,
  }
  worker.channel.handle(
    CapsuleSnapshotCommandName.SNAPSHOTS_LIST,
    async input => {
      return await worker.capsule.snapshot.list(input.target.id, input.capsuleId, {
        includeExperimental: input.includeExperimental,
      })
    },
    handlerOptions,
  )
  worker.channel.handle(
    CapsuleSnapshotCommandName.SNAPSHOT_CAPTURE,
    async input => {
      return await worker.capsule.capture.submit({
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
