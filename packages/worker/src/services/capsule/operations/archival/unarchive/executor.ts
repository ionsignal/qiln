import { CapsuleOperationType } from '@qiln/core/server'
import { ProviderFreeArchivalOperationExecution } from '../shared'
import type { CapsuleLifecycleEventPublisher, CapsuleOperationEventPublisher } from '../../../events'
import type { CapsuleUnarchiveRepository } from './repository'
import type { UnarchiveCapsuleExecutionInput, UnarchiveCapsuleTerminalResult } from './types'

const LOGGER_PREFIX = '[CapsuleUnarchiveExecutor]'

export interface CapsuleUnarchiveExecutorDependencies {
  repository: CapsuleUnarchiveRepository
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
}

/**
 * Executes one durably accepted, provider-free unarchive operation.
 *
 * The executor is a thin unarchive-specific composition boundary. The shared
 * execution coordinator owns the mechanical load, claim, completion, and
 * failure-dispatch sequence. The unarchive repository retains ownership of
 * lifecycle eligibility, exact archive-timestamp preservation, offline branch
 * lineage, and terminal classification.
 */
export class CapsuleUnarchiveExecutor {
  private readonly execution: ProviderFreeArchivalOperationExecution<
    UnarchiveCapsuleExecutionInput,
    UnarchiveCapsuleTerminalResult
  >

  constructor(private readonly dependencies: CapsuleUnarchiveExecutorDependencies) {
    this.execution = new ProviderFreeArchivalOperationExecution({
      operationType: CapsuleOperationType.UNARCHIVE,
      operationDescription: 'capsule unarchive',
      loggerPrefix: LOGGER_PREFIX,
      loadAcceptedExecution: operationId => this.dependencies.repository.loadAcceptedExecution(operationId),
      claimAccepted: operationId => this.dependencies.repository.claimAccepted(operationId),
      complete: operationId => this.dependencies.repository.complete(operationId),
      classifyExecutionFailure: (operationId, error, context) =>
        this.dependencies.repository.classifyExecutionFailure(operationId, error, context),
      publishOperationChanged: operation => this.dependencies.operationEvents.publishChanged(operation),
      publishTerminalResult: result => this.publishTerminalResult(result),
    })
  }

  public async execute(operationId: string): Promise<void> {
    await this.execution.execute(operationId)
  }

  private publishTerminalResult(result: UnarchiveCapsuleTerminalResult): void {
    this.dependencies.operationEvents.publishChanged(result.operation)
    this.dependencies.lifecycleEvents.publishChanged(result.operation.ownerId, result.capsule)
  }
}
