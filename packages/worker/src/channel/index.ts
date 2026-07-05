import { registerCapsuleBranchHandlers } from './handlers/capsule'
import { registerCapsuleBlueprintHandlers } from './handlers/blueprints'
import type { QilnWorkerRuntime } from '../runtime'

/**
 * Registers all worker-side Capsule Channel handlers.
 */
export function registerCapsuleChannelHandlers(worker: QilnWorkerRuntime): void {
  registerCapsuleBranchHandlers(worker)
  registerCapsuleBlueprintHandlers(worker)
}
