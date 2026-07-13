import type { BootstrapExecutionState } from '../executionState'
import type { BootstrapOperationContext } from '../types'
import type { CapsuleBranchEventPublisher } from '../../branch/events'
import type { CapsuleLifecycleOperationStore } from '../../stores'

/**
 * Atomically commits the accepted capsule and its root branch to their first usable state.
 *
 * Execution state is marked only after the aggregate transaction commits. A later failure must preserve
 * the finalized runtime rather than entering bootstrap provider compensation.
 */
export class BootstrapFinalizationPhase {
  constructor(
    private readonly operations: CapsuleLifecycleOperationStore,
    private readonly events: CapsuleBranchEventPublisher,
  ) {}

  public async finalizeCapsuleActive(context: BootstrapOperationContext, state: BootstrapExecutionState): Promise<void> {
    const finalized = await this.operations.finalizeBootstrapAggregateActive(context.ownerId, context.capsuleId, context.branchId)
    state.markOfflineBranchFinalized()
    this.events.publishStateChanged(context.ownerId, context.capsuleId, finalized.branchName, 'offline')
  }
}
