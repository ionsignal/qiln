import type { CapsuleLifecycleEventPublisher, CapsuleOperationEventPublisher } from '../../../events'
import type { CapsuleUnarchiveRepository } from './repository'
import type { UnarchiveCapsuleTerminalResult } from './types'

export interface CapsuleUnarchiveExecutorDependencies {
  repository: CapsuleUnarchiveRepository
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
}

/**
 * Executes one durably accepted, provider-free unarchive operation.
 *
 * The executor receives only the operation ID. PostgreSQL is reloaded before
 * claiming, and the repository retains ownership of archive-timestamp policy
 * and all terminal classification.
 */
export class CapsuleUnarchiveExecutor {
  constructor(private readonly dependencies: CapsuleUnarchiveExecutorDependencies) {}

  public async execute(operationId: string): Promise<void> {
    const input = await this.dependencies.repository.loadAcceptedExecution(operationId)
    const running = await this.dependencies.repository.claimAccepted(operationId)
    this.dependencies.operationEvents.publishChanged(running)
    try {
      const completed = await this.dependencies.repository.complete(operationId)
      this.publishTerminalResult(completed)
    } catch (unarchiveError: unknown) {
      try {
        const terminal = await this.dependencies.repository.finalizeExecutionFailure(operationId, unarchiveError, {
          operationId,
          capsuleId: input.capsuleId,
          phase: 'execute_unarchive',
          action: 'complete_capsule_unarchive',
          providerIntentExpected: false,
        })
        this.publishTerminalResult(terminal)
      } catch (terminalizationError: unknown) {
        console.error(`[CapsuleUnarchiveExecutor] Failed to terminalize capsule unarchive operation '${operationId}'.`, {
          unarchiveError,
          terminalizationError,
        })
        throw terminalizationError
      }
      throw unarchiveError
    }
  }

  private publishTerminalResult(result: UnarchiveCapsuleTerminalResult): void {
    this.dependencies.operationEvents.publishChanged(result.operation)
    this.dependencies.lifecycleEvents.publishChanged(result.operation.ownerId, result.capsule)
  }
}
