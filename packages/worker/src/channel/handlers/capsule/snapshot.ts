import { CapsuleSnapshotCommandName, type CapsuleCommandHandlerOptions } from '@qiln/core/server'
import { mapWorkerCapsuleCommandError } from '../../errors'
import type { QilnWorkerRuntime } from '../../../runtime'

/**
 * Registers the read-only logical snapshot history handler.
 *
 * Snapshot capture remains intentionally absent until Qiln can prove complete artifact manifests
 * and physical snapshot references in one durable mutation.
 */
export function registerCapsuleSnapshotHandlers(worker: QilnWorkerRuntime): void {
  const handlerOptions: CapsuleCommandHandlerOptions = {
    mapError: mapWorkerCapsuleCommandError,
  }
  worker.channel.handle(
    CapsuleSnapshotCommandName.SNAPSHOTS_LIST,
    async input => {
      return await worker.capsule.snapshot.list(input.target.id)
    },
    handlerOptions,
  )
}
