import { CapsuleAgentReadCommandName, type CapsuleCommandHandlerOptions } from '@qiln/core/server'
import { mapWorkerCapsuleCommandError } from '../../errors'
import type { QilnWorkerRuntime } from '../../../runtime'

/**
 * Registers immutable committed snapshot reads for authenticated external
 * agents. The host derives credential authority before publishing these
 * commands; the Worker independently proves committed snapshot lineage.
 */
export function registerCapsuleAgentReadHandler(worker: QilnWorkerRuntime): void {
  const handlerOptions: CapsuleCommandHandlerOptions = {
    mapError: mapWorkerCapsuleCommandError,
  }

  worker.channel.handle(
    CapsuleAgentReadCommandName.MANIFEST_ROOTS,
    async input => {
      return await worker.capsule.snapshot.manifestRoots(input.target.id, input.capsuleId, {
        snapshotId: input.snapshotId,
        ...(input.afterRootId === undefined ? {} : { afterRootId: input.afterRootId }),
        limit: input.limit,
      })
    },
    handlerOptions,
  )

  worker.channel.handle(
    CapsuleAgentReadCommandName.MANIFEST_ENTRIES,
    async input => {
      return await worker.capsule.snapshot.manifestEntries(input.target.id, input.capsuleId, {
        snapshotId: input.snapshotId,
        rootId: input.rootId,
        ...(input.afterLogicalPath === undefined ? {} : { afterLogicalPath: input.afterLogicalPath }),
        limit: input.limit,
      })
    },
    handlerOptions,
  )

  worker.channel.handle(
    CapsuleAgentReadCommandName.ARTIFACT_CONTENT,
    async input => {
      return await worker.capsule.snapshot.artifactContent(input.target.id, input.capsuleId, {
        snapshotId: input.snapshotId,
        rootId: input.rootId,
        logicalPath: input.logicalPath,
      })
    },
    handlerOptions,
  )
}
