import type { BranchOperationStepInput, CapsuleBranchOperationStepStore } from '../stores'

const INLINE_STEP_EXECUTOR_LOG_PREFIX = '[CapsuleInlineStepExecutor]'

export type InlineOperationStepContext = Omit<BranchOperationStepInput, 'status'>
export type InlineOperationStepAction<TResult> = () => Promise<TResult> | TResult

/**
 * Executes one deterministic operation step inline while persisting step state.
 *
 * This is deliberately not a runner, queue, scheduler, lease manager, or recovery engine.
 * It only wraps the current synchronous saga flow with durable step visibility so recovery can be layered on later.
 */
export class InlineOperationStepExecutor {
  constructor(private readonly steps: CapsuleBranchOperationStepStore) {}

  public async run<TResult>(context: InlineOperationStepContext, action: InlineOperationStepAction<TResult>): Promise<TResult> {
    const stepId = await this.steps.ensureStep(context)
    await this.steps.markStepRunning(stepId, context.metadata)
    try {
      const result = await action()
      await this.steps.markStepCompleted(stepId)
      return result
    } catch (error: unknown) {
      await this.markStepFailureBestEffort(stepId, context.stepKey, error)
      throw error
    }
  }

  private async markStepFailureBestEffort(stepId: string, stepKey: string, error: unknown): Promise<void> {
    try {
      await this.steps.markStepFailure(stepId, error)
    } catch (failurePersistenceError: unknown) {
      console.error(
        `${INLINE_STEP_EXECUTOR_LOG_PREFIX} Failed to persist failure state for step '${stepKey}' (${stepId}).`,
        failurePersistenceError,
      )
    }
  }
}
