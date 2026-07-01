import { registerCapsuleBranchHandlers } from './handlers/capsule'
import type { QilnWorkerRuntime } from '../runtime'

/**
 * Registers all worker-side Capsule Channel handlers.
 */
export function registerCapsuleChannelHandlers(worker: QilnWorkerRuntime): void {
  registerCapsuleBranchHandlers(worker)
}
