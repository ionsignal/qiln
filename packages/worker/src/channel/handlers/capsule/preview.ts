import { CapsulePreviewCommandName, type CapsuleCommandHandlerOptions } from '@qiln/core/server'
import { mapWorkerCapsuleCommandError } from '../../errors'
import type { QilnWorkerRuntime } from '../../../runtime'

export function registerCapsulePreviewHandlers(worker: QilnWorkerRuntime): void {
  const handlerOptions: CapsuleCommandHandlerOptions = {
    mapError: mapWorkerCapsuleCommandError,
  }

  worker.channel.handle(
    CapsulePreviewCommandName.PREVIEWS_LIST,
    async input => {
      return await worker.capsule.preview.list(input.target.id, input.capsuleId)
    },
    handlerOptions,
  )
}
