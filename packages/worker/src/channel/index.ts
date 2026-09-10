import { registerSshAuthorizedKeysSyncHandler } from './handlers/ssh'
import { registerCapsuleBlueprintHandlers } from './handlers/blueprint'
import { registerCapsuleBranchHandlers } from './handlers/capsule/branch'
import { registerCapsuleCreateHandler } from './handlers/capsule/create'
import { registerCapsuleForkHandler } from './handlers/capsule/fork'
import { registerCapsuleRouteHandlers } from './handlers/capsule/routing'
import { registerCapsuleSnapshotHandlers } from './handlers/capsule/snapshot'
import { registerCapsulePreviewHandlers } from './handlers/capsule/preview'
import { registerCapsuleLifecycleArchiveHandler } from './handlers/capsule/lifecycle/archive'
import { registerCapsuleLifecycleDestroyHandler } from './handlers/capsule/lifecycle/destroy'
import { registerCapsuleLifecycleUnarchiveHandler } from './handlers/capsule/lifecycle/unarchive'
import type { QilnWorkerRuntime } from '../runtime'

/**
 * Registers the Worker-side Capsule Channel command responders.
 *
 * Runtime startup invokes this only after singleton acquisition, abandoned
 * operation classification, and branch runtime reconciliation have completed.
 */
export function registerCapsuleChannelHandlers(worker: QilnWorkerRuntime): void {
  registerSshAuthorizedKeysSyncHandler(worker)
  registerCapsuleBlueprintHandlers(worker)
  registerCapsuleCreateHandler(worker)
  registerCapsuleForkHandler(worker)
  registerCapsuleBranchHandlers(worker)
  registerCapsuleSnapshotHandlers(worker)
  registerCapsulePreviewHandlers(worker)
  registerCapsuleRouteHandlers(worker)
  registerCapsuleLifecycleDestroyHandler(worker)
  registerCapsuleLifecycleArchiveHandler(worker)
  registerCapsuleLifecycleUnarchiveHandler(worker)
}
