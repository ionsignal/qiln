import { CapsuleOperationStepPersistenceError } from './errors'
import type { BranchOperationStepInput, CapsuleBranchOperationStepStore } from '../stores'

const INLINE_STEP_EXECUTOR_LOG_PREFIX = '[CapsuleInlineStepExecutor]'

export type InlineOperationStepContext = Omit<BranchOperationStepInput, 'status'>
export type InlineOperationStepAction<TResult> = () => Promise<TResult> | TResult

/**
 * Executes one deterministic operation step inline while persisting step state.
 *
 * This is deliberately not a runner, queue, scheduler, lease manager, or recovery engine. Existing step rows are
 * durable inspection/accounting records; the executor does not skip completed steps or resume abandoned provisioning.
 */
export class InlineOperationStepExecutor {
  constructor(private readonly steps: CapsuleBranchOperationStepStore) {}

  public async run<TResult>(context: InlineOperationStepContext, action: InlineOperationStepAction<TResult>): Promise<TResult> {
    let stepId: string
    try {
      stepId = await this.steps.ensureStep(context)
    } catch (error: unknown) {
      throw new CapsuleOperationStepPersistenceError(`Failed to ensure capsule operation step '${context.stepKey}'.`, {
        stepKey: context.stepKey,
        transition: 'ensure',
        error,
      })
    }
    try {
      await this.steps.markStepRunning(stepId, context.metadata)
    } catch (error: unknown) {
      throw new CapsuleOperationStepPersistenceError(`Failed to mark capsule operation step '${context.stepKey}' as running.`, {
        stepId,
        stepKey: context.stepKey,
        transition: 'running',
        error,
      })
    }
    let result: TResult
    try {
      result = await action()
    } catch (error: unknown) {
      await this.markStepFailureBestEffort(stepId, context.stepKey, error)
      throw error
    }
    try {
      await this.steps.markStepCompleted(stepId)
    } catch (error: unknown) {
      throw new CapsuleOperationStepPersistenceError(
        `Capsule operation step '${context.stepKey}' completed but completion state was not persisted.`,
        {
          stepId,
          stepKey: context.stepKey,
          transition: 'completed',
          error,
        },
      )
    }
    return result
  }

  private async markStepFailureBestEffort(stepId: string, stepKey: string, error: unknown): Promise<void> {
    try {
      await this.steps.markStepFailure(stepId, error, {
        stepKey,
        action: 'execute_inline_step',
      })
    } catch (failurePersistenceError: unknown) {
      console.error(
        `${INLINE_STEP_EXECUTOR_LOG_PREFIX} Failed to persist failure state for step '${stepKey}' (${stepId}).`,
        failurePersistenceError,
      )
    }
  }
}
