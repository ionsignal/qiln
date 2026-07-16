import type { CapsuleLifecycleEventPublisher, CapsuleOperationEventPublisher } from '../../../events'
import type { CapsuleArchiveRepository } from './repository'
import type { ArchiveCapsuleTerminalResult } from './types'

export interface CapsuleArchiveExecutorDependencies {
  repository: CapsuleArchiveRepository
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
}

/**
 * Executes one durably accepted, provider-free archive operation.
 *
 * The executor receives only the operation ID. PostgreSQL is reloaded before
 * claiming, and the repository retains ownership of all archive lifecycle and
 * terminal-classification policy.
 */
export class CapsuleArchiveExecutor {
  constructor(private readonly dependencies: CapsuleArchiveExecutorDependencies) {}

  public async execute(operationId: string): Promise<void> {
    const input = await this.dependencies.repository.loadAcceptedExecution(operationId)
    const running = await this.dependencies.repository.claimAccepted(operationId)
    this.dependencies.operationEvents.publishChanged(running)
    try {
      const completed = await this.dependencies.repository.complete(operationId)
      this.publishTerminalResult(completed)
    } catch (archiveError: unknown) {
      try {
        const terminal = await this.dependencies.repository.finalizeExecutionFailure(operationId, archiveError, {
          operationId,
          capsuleId: input.capsuleId,
          phase: 'execute_archive',
          action: 'complete_capsule_archive',
          providerIntentExpected: false,
        })
        this.publishTerminalResult(terminal)
      } catch (terminalizationError: unknown) {
        console.error(`[CapsuleArchiveExecutor] Failed to terminalize capsule archive operation '${operationId}'.`, {
          archiveError,
          terminalizationError,
        })
        throw terminalizationError
      }
      throw archiveError
    }
  }

  private publishTerminalResult(result: ArchiveCapsuleTerminalResult): void {
    this.dependencies.operationEvents.publishChanged(result.operation)
    this.dependencies.lifecycleEvents.publishChanged(result.operation.ownerId, result.capsule)
  }
}
