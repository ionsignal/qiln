import { assertAbandonedOperationTransitionIdentity, type CapsuleOperationAbandonmentHandlerRegistry } from './handler'
import type {
  CapsuleOperationReader,
  CapsuleOperationStepStore,
  CapsuleOperationTransitionOutput,
  PersistedCapsuleOperation,
} from '../shared'

const LOGGER_PREFIX = '[CapsuleOperationAbandonmentCoordinator]'
const ABANDONED_STEP_FAILURE_CODE = 'ABANDONED_CAPSULE_OPERATION'
const ABANDONED_STEP_FAILURE_MESSAGE = 'Capsule operation was abandoned before completion.'

export interface CapsuleOperationAbandonmentCoordinatorDependencies {
  reader: CapsuleOperationReader
  steps: CapsuleOperationStepStore
  handlers: CapsuleOperationAbandonmentHandlerRegistry
}

/**
 * Coordinates startup classification of durable nonterminal capsule operations.
 *
 * Operation-specific classification, aggregate transitions, identity
 * validation, and invalidation publication belong to registered handlers. This
 * coordinator owns only startup dispatch and common post-classification step
 * accounting.
 *
 * Classification remains fail-closed:
 *
 * - Every durable operation type must have a registered handler;
 * - Operations are classified sequentially;
 * - A handler failure aborts Worker startup;
 * - Executors are never invoked;
 * - Provider mutations are never retried;
 * - Operation steps are never treated as resumable checkpoints.
 */
export class CapsuleOperationAbandonmentCoordinator {
  constructor(private readonly dependencies: CapsuleOperationAbandonmentCoordinatorDependencies) {}

  /**
   * Classifies operations left accepted or running by an earlier Worker
   * process.
   *
   * Handler coverage is validated before reading or dispatching operations so a
   * newly introduced operation type cannot silently omit its startup
   * abandonment policy merely because no nonterminal row currently exists for
   * that type.
   */
  public async classifyAtStartup(): Promise<void> {
    this.dependencies.handlers.assertComplete()
    const operations = await this.dependencies.reader.listNonterminal()
    if (operations.length === 0) {
      return
    }
    console.warn(
      `${LOGGER_PREFIX} Found ${operations.length} nonterminal capsule operation(s) from an earlier Worker process. Classifying without resuming execution.`,
    )
    let classifiedCount = 0
    let noChangeCount = 0
    for (const operation of operations) {
      try {
        const handler = this.dependencies.handlers.require(operation.type)
        const result = await handler.classify(operation)
        if (!result.classified) {
          noChangeCount++
          continue
        }

        /**
         * Operation-local handlers must perform this assertion before
         * publishing invalidations. Repeating it here protects shared
         * post-classification accounting from an incorrectly implemented
         * handler.
         */
        assertAbandonedOperationTransitionIdentity(operation, result.operation)

        classifiedCount++

        await this.markAbandonedStepsFailedBestEffort(operation, result.operation)
      } catch (error: unknown) {
        console.error(
          `${LOGGER_PREFIX} Failed to classify abandoned '${operation.type}' operation '${operation.id}'. Worker startup must fail closed.`,
          error,
        )

        throw error
      }
    }
    console.warn(
      `${LOGGER_PREFIX} Startup abandonment classification finished. Classified ${classifiedCount}; no longer nonterminal ${noChangeCount}.`,
    )
  }

  /**
   * Fails remaining nonterminal step rows only after an operation-local handler
   * has committed aggregate classification and published its best-effort
   * invalidations.
   *
   * Step accounting is inspection data. Failure to update it must not alter,
   * retry, or obscure the committed operation-specific classification.
   */
  private async markAbandonedStepsFailedBestEffort(
    discoveredOperation: PersistedCapsuleOperation,
    committedOperation: CapsuleOperationTransitionOutput,
  ): Promise<void> {
    try {
      await this.dependencies.steps.markNonterminalStepsFailedAfterAbandonedClassification({
        operationId: committedOperation.operationId,
        failureCode: ABANDONED_STEP_FAILURE_CODE,
        failureMessage: ABANDONED_STEP_FAILURE_MESSAGE,
        context: {
          operationId: committedOperation.operationId,
          operationType: committedOperation.operationType,
          capsuleId: committedOperation.capsuleId,
          previousOperationStatus: discoveredOperation.status,
          classifiedOperationStatus: committedOperation.operationStatus,
          providerIntentCommitted: discoveredOperation.providerMutationStartedAt !== null,
          providerMutationStartedAt: discoveredOperation.providerMutationStartedAt?.toISOString() ?? null,
          classification: 'startup_abandoned_operation_classification',
          policy: 'no_executor_replay_after_worker_restart',
        },
      })
    } catch (error: unknown) {
      console.error(
        `${LOGGER_PREFIX} Operation '${committedOperation.operationId}' was classified as '${committedOperation.operationStatus}', but its remaining nonterminal step records could not be marked failed.`,
        error,
      )
    }
  }
}
