import { registerCapsuleBlueprintHandlers } from './handlers/blueprints'
import { registerCapsuleArchiveHandler } from './handlers/capsule/archive'
import { registerCapsuleBranchHandlers } from './handlers/capsule/branch'
import { registerCapsuleCreateHandler } from './handlers/capsule/create'
import { registerCapsuleDestroyHandler } from './handlers/capsule/destroy'
import { registerCapsuleSnapshotHandlers } from './handlers/capsule/snapshot'
import { registerCapsuleUnarchiveHandler } from './handlers/capsule/unarchive'
import type { QilnWorkerRuntime } from '../runtime'

/**
 * Registers the Worker-side Capsule Channel command responders.
 *
 * Runtime startup invokes this only after singleton acquisition, abandoned
 * operation classification, and branch runtime reconciliation have completed.
 */
export function registerCapsuleChannelHandlers(worker: QilnWorkerRuntime): void {
  registerCapsuleCreateHandler(worker)
  registerCapsuleArchiveHandler(worker)
  registerCapsuleUnarchiveHandler(worker)
  registerCapsuleDestroyHandler(worker)
  registerCapsuleBranchHandlers(worker)
  registerCapsuleSnapshotHandlers(worker)
  registerCapsuleBlueprintHandlers(worker)
}
