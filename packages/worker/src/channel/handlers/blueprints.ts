import { CapsuleBlueprintCommandName, type CapsuleCommandHandlerOptions } from '@qiln/core/server'
import { mapWorkerCapsuleCommandError } from '../errors'
import type { QilnWorkerRuntime } from '../../runtime'

/**
 * Registers worker-authoritative capsule blueprint discovery handlers.
 *
 * The worker owns the loaded blueprint registry because it is the process that
 * actually provisions branches from those definitions.
 */
export function registerCapsuleBlueprintHandlers(worker: QilnWorkerRuntime): void {
  const handlerOptions: CapsuleCommandHandlerOptions = {
    mapError: mapWorkerCapsuleCommandError,
  }

  worker.channel.handle(
    CapsuleBlueprintCommandName.BLUEPRINTS_LIST,
    () => {
      return worker.blueprints.manifest()
    },
    handlerOptions,
  )
}
