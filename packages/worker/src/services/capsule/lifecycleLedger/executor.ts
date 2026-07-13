import { CapsuleLifecycleStepPersistenceError } from './errors'
import type { CapsuleLifecycleOperationStepStore } from '../stores/lifecycleOperationStepStore'
import type { LifecycleOperationStepInput } from '../stores/types'

const INLINE_STEP_EXECUTOR_LOG_PREFIX = '[CapsuleInlineLifecycleStepExecutor]'

export type InlineLifecycleStepContext = Omit<LifecycleOperationStepInput, 'status'>
export type InlineLifecycleStepAction<TResult> = () => Promise<TResult> | TResult

/**
 * Executes one deterministic lifecycle step inline while persisting its
 * accounting state.
 *
 * This is deliberately not a runner, queue, scheduler, lease manager, retry
 * mechanism, or recovery engine. Existing step rows are durable inspection
 * records; this executor never skips completed steps or resumes abandoned work.
 */
export class InlineLifecycleStepExecutor {
  constructor(private readonly steps: CapsuleLifecycleOperationStepStore) {}

  public async run<TResult>(context: InlineLifecycleStepContext, action: InlineLifecycleStepAction<TResult>): Promise<TResult> {
    let stepId: string
    try {
      stepId = await this.steps.ensureStep(context)
    } catch (error: unknown) {
      throw new CapsuleLifecycleStepPersistenceError(`Failed to ensure capsule lifecycle step '${context.stepKey}'.`, {
        stepKey: context.stepKey,
        transition: 'ensure',
        error,
      })
    }
    try {
      await this.steps.markStepRunning(stepId, context.metadata)
    } catch (error: unknown) {
      throw new CapsuleLifecycleStepPersistenceError(`Failed to mark capsule lifecycle step '${context.stepKey}' as running.`, {
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
      throw new CapsuleLifecycleStepPersistenceError(
        `Capsule lifecycle step '${context.stepKey}' completed but its completion state was not persisted.`,
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
        action: 'execute_inline_lifecycle_step',
      })
    } catch (failurePersistenceError: unknown) {
      console.error(
        `${INLINE_STEP_EXECUTOR_LOG_PREFIX} Failed to persist failure state for lifecycle step '${stepKey}' (${stepId}).`,
        failurePersistenceError,
      )
    }
  }
}
