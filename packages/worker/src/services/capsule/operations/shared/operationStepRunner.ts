import { IncusError } from '../../../../errors'
import type { CapsuleOperationStepStore } from './operationStepStore'

export interface CapsuleOperationStepRunInput<TStepKey extends string = string> {
  operationId: string
  capsuleId: string
  ownerId: string
  branchId: string | null
  branchName: string | null
  stepKey: TStepKey
  metadata: Record<string, unknown>
  failureContext: Record<string, unknown>
}

/**
 * Executes one action within a durable operation-step accounting boundary.
 *
 * Operation steps are inspection records only. This runner never skips,
 * resumes, retries, replays, or otherwise authorizes operation work based on an
 * existing step row.
 *
 * The operation-specific executor remains responsible for:
 *
 * - Choosing the ordered action;
 * - Selecting the step key;
 * - Tracking its process-local failure phase;
 * - Deciding compensation and terminal aggregate policy.
 */
export class CapsuleOperationStepRunner {
  constructor(private readonly steps: CapsuleOperationStepStore) {}

  public async run<TResult, TStepKey extends string>(
    input: CapsuleOperationStepRunInput<TStepKey>,
    action: () => Promise<TResult> | TResult,
  ): Promise<TResult> {
    const stepId = await this.steps.ensureStep({
      operationId: input.operationId,
      capsuleId: input.capsuleId,
      ownerId: input.ownerId,
      branchId: input.branchId,
      branchName: input.branchName,
      stepKey: input.stepKey,
      metadata: input.metadata,
    })
    await this.steps.markStepRunning(stepId, input.metadata)
    let result: TResult
    try {
      result = await action()
    } catch (error: unknown) {
      await this.markStepFailedBestEffort(stepId, input, error)
      throw error
    }
    try {
      await this.steps.markStepCompleted(stepId)
    } catch (error: unknown) {
      throw new IncusError(
        `Capsule operation step '${input.stepKey}' completed but its accounting outcome was not persisted.`,
        'API_ERROR',
        {
          operationId: input.operationId,
          capsuleId: input.capsuleId,
          branchId: input.branchId,
          stepId,
          stepKey: input.stepKey,
          cause: error instanceof Error ? error.message : 'Unknown operation-step persistence failure',
        },
      )
    }
    return result
  }

  private async markStepFailedBestEffort<TStepKey extends string>(
    stepId: string,
    input: CapsuleOperationStepRunInput<TStepKey>,
    error: unknown,
  ): Promise<void> {
    try {
      await this.steps.markStepFailed(stepId, error, {
        operationId: input.operationId,
        capsuleId: input.capsuleId,
        branchId: input.branchId,
        branchName: input.branchName,
        stepKey: input.stepKey,
        ...input.failureContext,
      })
    } catch (persistenceError: unknown) {
      console.error(
        `[CapsuleOperationStepRunner] Failed to persist failure for operation step '${input.stepKey}' (${stepId}).`,
        persistenceError,
      )
    }
  }
}
