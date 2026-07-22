import { CapsuleOperationStatus } from '@qiln/core/server'
import type { CapsuleOperationTransitionOutput } from '../../shared'
import type { ProviderFreeArchivalOperationType } from './operationLedger'

export const ProviderFreeArchivalExecutionPhase = {
  LOAD_EXECUTION_INPUT: 'load_execution_input',
  CLAIM_OPERATION: 'claim_operation',
  COMPLETE_OPERATION: 'complete_operation',
} as const

export type ProviderFreeArchivalExecutionPhase =
  (typeof ProviderFreeArchivalExecutionPhase)[keyof typeof ProviderFreeArchivalExecutionPhase]

export interface ProviderFreeArchivalExecutionInput {
  ownerId: string
  capsuleId: string
}

export interface ProviderFreeArchivalTerminalResult {
  operation: CapsuleOperationTransitionOutput
}

export interface ProviderFreeArchivalOperationExecutionDefinition<
  TExecutionInput extends ProviderFreeArchivalExecutionInput,
  TTerminalResult extends ProviderFreeArchivalTerminalResult,
> {
  operationType: ProviderFreeArchivalOperationType
  operationDescription: string
  loggerPrefix: string
  loadAcceptedExecution(operationId: string): Promise<TExecutionInput>
  claimAccepted(operationId: string): Promise<CapsuleOperationTransitionOutput>
  complete(operationId: string): Promise<TTerminalResult>
  classifyExecutionFailure(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<TTerminalResult | null>
  publishOperationChanged(operation: CapsuleOperationTransitionOutput): void
  publishTerminalResult(result: TTerminalResult): void
}

/**
 * Coordinates the mechanical execution shell shared by provider-free archive
 * and unarchive operations.
 */
export class ProviderFreeArchivalOperationExecution<
  TExecutionInput extends ProviderFreeArchivalExecutionInput,
  TTerminalResult extends ProviderFreeArchivalTerminalResult,
> {
  constructor(
    private readonly definition: ProviderFreeArchivalOperationExecutionDefinition<TExecutionInput, TTerminalResult>,
  ) {}

  public async execute(operationId: string): Promise<void> {
    let phase: ProviderFreeArchivalExecutionPhase = ProviderFreeArchivalExecutionPhase.LOAD_EXECUTION_INPUT
    let executionInput: TExecutionInput | null = null
    const runPhase = async <TResult>(
      executionPhase: ProviderFreeArchivalExecutionPhase,
      action: () => Promise<TResult>,
    ): Promise<TResult> => {
      phase = executionPhase
      return await action()
    }
    try {
      executionInput = await runPhase(ProviderFreeArchivalExecutionPhase.LOAD_EXECUTION_INPUT, () =>
        this.definition.loadAcceptedExecution(operationId),
      )
      const running = await runPhase(ProviderFreeArchivalExecutionPhase.CLAIM_OPERATION, () =>
        this.definition.claimAccepted(operationId),
      )
      this.assertRunningTransition(operationId, executionInput, running)
      this.publishOperationChangedSafely(running)
      const completed = await runPhase(ProviderFreeArchivalExecutionPhase.COMPLETE_OPERATION, () =>
        this.definition.complete(operationId),
      )
      this.assertTerminalResult(operationId, executionInput, completed)
      this.publishTerminalResultSafely(completed)
    } catch (executionError: unknown) {
      const failureContext = this.createFailureContext(operationId, executionInput, phase)
      let terminalResult: TTerminalResult | null
      try {
        terminalResult = await this.definition.classifyExecutionFailure(operationId, executionError, failureContext)
        if (terminalResult !== null) {
          this.assertTerminalResult(operationId, executionInput, terminalResult)
        }
      } catch (classificationError: unknown) {
        console.error(
          `${this.definition.loggerPrefix} Failed to terminalize ${this.definition.operationDescription} operation '${operationId}'.`,
          {
            executionError,
            classificationError,
            failedPhase: phase,
          },
        )
        throw classificationError
      }
      if (terminalResult === null) {
        /**
         * A null result proves the operation became terminal before failure
         * classification acquired its lock. This commonly covers an ambiguous
         * database response after a successful completion commit.
         *
         * PostgreSQL is authoritative, so the executor must not overwrite or
         * reinterpret that already-terminal state.
         */
        console.warn(
          `${this.definition.loggerPrefix} ${this.definition.operationDescription} operation '${operationId}' was already terminal when execution failure classification ran.`,
          {
            failedPhase: phase,
          },
        )
        return
      }
      this.publishTerminalResultSafely(terminalResult)
      /**
       * The operation-specific repository has committed terminal failure state.
       * Rethrowing preserves process-level diagnostics without changing the
       * durable classification or causing retry behavior.
       */
      throw executionError
    }
  }

  private assertRunningTransition(
    operationId: string,
    executionInput: TExecutionInput,
    operation: CapsuleOperationTransitionOutput,
  ): void {
    this.assertTransitionIdentity(operationId, executionInput, operation)
    if (operation.operationStatus !== CapsuleOperationStatus.RUNNING) {
      throw new Error(
        `${this.definition.loggerPrefix} ${this.definition.operationDescription} claim for operation '${operationId}' ` +
          `returned status '${operation.operationStatus}' instead of '${CapsuleOperationStatus.RUNNING}'.`,
      )
    }
  }

  private assertTerminalResult(
    operationId: string,
    executionInput: TExecutionInput | null,
    result: TTerminalResult,
  ): void {
    this.assertTransitionIdentity(operationId, executionInput, result.operation)
    if (
      result.operation.operationStatus === CapsuleOperationStatus.ACCEPTED ||
      result.operation.operationStatus === CapsuleOperationStatus.RUNNING
    ) {
      throw new Error(
        `${this.definition.loggerPrefix} ${this.definition.operationDescription} terminal result for operation '${operationId}' ` +
          `returned nonterminal status '${result.operation.operationStatus}'.`,
      )
    }
  }

  private assertTransitionIdentity(
    operationId: string,
    executionInput: TExecutionInput | null,
    operation: CapsuleOperationTransitionOutput,
  ): void {
    const mismatches: string[] = []
    if (operation.operationId !== operationId) {
      mismatches.push('operationId')
    }
    if (operation.operationType !== this.definition.operationType) {
      mismatches.push('operationType')
    }
    if (executionInput !== null) {
      if (operation.ownerId !== executionInput.ownerId) {
        mismatches.push('ownerId')
      }

      if (operation.capsuleId !== executionInput.capsuleId) {
        mismatches.push('capsuleId')
      }
    }
    if (mismatches.length === 0) {
      return
    }
    throw new Error(
      [
        `${this.definition.loggerPrefix} ${this.definition.operationDescription} operation transition failed identity validation.`,
        `Mismatched fields: ${mismatches.join(', ')}.`,
        `Expected operation '${operationId}' of type '${this.definition.operationType}'.`,
        `Received operation '${operation.operationId}' of type '${operation.operationType}'.`,
      ].join(' '),
    )
  }

  private createFailureContext(
    operationId: string,
    executionInput: TExecutionInput | null,
    failedPhase: ProviderFreeArchivalExecutionPhase,
  ): Record<string, unknown> {
    return {
      operationId,
      operationType: this.definition.operationType,
      operationDescription: this.definition.operationDescription,
      phase: 'provider_free_archival_execution_failure',
      failedPhase,
      action: 'classify_provider_free_archival_execution_failure',
      providerIntentExpected: false,
      ...(executionInput === null
        ? {}
        : {
            ownerId: executionInput.ownerId,
            capsuleId: executionInput.capsuleId,
          }),
    }
  }

  private publishOperationChangedSafely(operation: CapsuleOperationTransitionOutput): void {
    try {
      this.definition.publishOperationChanged(operation)
    } catch (error: unknown) {
      console.warn(
        `${this.definition.loggerPrefix} Failed to publish committed running state for ${this.definition.operationDescription} operation '${operation.operationId}'.`,
        error,
      )
    }
  }

  private publishTerminalResultSafely(result: TTerminalResult): void {
    try {
      this.definition.publishTerminalResult(result)
    } catch (error: unknown) {
      console.warn(
        `${this.definition.loggerPrefix} Failed to publish committed terminal state for ${this.definition.operationDescription}.`,
        error,
      )
    }
  }
}
