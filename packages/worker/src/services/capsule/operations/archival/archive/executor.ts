import { CapsuleOperationType } from '@qiln/core/server'
import { ProviderFreeArchivalOperationExecution } from '../shared'
import type { CapsuleLifecycleEventPublisher, CapsuleOperationEventPublisher } from '../../../events'
import type { CapsuleArchiveRepository } from './repository'
import type { ArchiveCapsuleExecutionInput, ArchiveCapsuleTerminalResult } from './types'

const LOGGER_PREFIX = '[CapsuleArchiveExecutor]'

export interface CapsuleArchiveExecutorDependencies {
  repository: CapsuleArchiveRepository
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
}

/**
 * Executes one durably accepted, provider-free archive operation.
 *
 * The executor is a thin archive-specific composition boundary. The shared
 * execution coordinator owns the mechanical load, claim, completion, and
 * failure-dispatch sequence. The archive repository retains ownership of
 * lifecycle eligibility, offline branch-lineage policy, archive timestamp
 * policy, and terminal classification.
 */
export class CapsuleArchiveExecutor {
  private readonly execution: ProviderFreeArchivalOperationExecution<
    ArchiveCapsuleExecutionInput,
    ArchiveCapsuleTerminalResult
  >

  constructor(private readonly dependencies: CapsuleArchiveExecutorDependencies) {
    this.execution = new ProviderFreeArchivalOperationExecution({
      operationType: CapsuleOperationType.ARCHIVE,
      operationDescription: 'capsule archive',
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

  private publishTerminalResult(result: ArchiveCapsuleTerminalResult): void {
    this.dependencies.operationEvents.publishChanged(result.operation)
    this.dependencies.lifecycleEvents.publishChanged(result.operation.ownerId, result.capsule)
  }
}
