import { registerCapsuleBootstrapHandlers } from './handlers/capsule/bootstrap'
import { registerCapsuleBranchHandlers } from './handlers/capsule/branch'
import { registerCapsuleLifecycleHandlers } from './handlers/capsule/lifecycle'
import { registerCapsuleSnapshotHandlers } from './handlers/capsule/snapshot'
import { registerCapsuleBlueprintHandlers } from './handlers/blueprints'
import type { QilnWorkerRuntime } from '../runtime'

/**
 * Registers all Worker-side Capsule Channel handlers.
 *
 * Registration occurs only after the Worker has completed its fail-closed
 * startup sweep for lifecycle operations abandoned by an earlier process.
 */
export function registerCapsuleChannelHandlers(worker: QilnWorkerRuntime): void {
  registerCapsuleBootstrapHandlers(worker)
  registerCapsuleBranchHandlers(worker)
  registerCapsuleLifecycleHandlers(worker)
  registerCapsuleSnapshotHandlers(worker)
  registerCapsuleBlueprintHandlers(worker)
}
