import { eq } from 'drizzle-orm'
import {
  CapsuleBranchOperationStepStatus,
  capsuleBranchOperationStepsTable,
  type CapsuleBranchOperationStepStatus as CapsuleBranchOperationStepStatusValue,
  type CapsuleHostDbContract,
} from '@qiln/core/server'
import { IncusError, isUniqueConstraintViolation } from '../../../errors'
import { toJsonObject } from './jsonPersistence'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from './errorDetails'
import type { BranchOperationStepInput } from './types'

/**
 * Persistence boundary for deterministic branch operation steps.
 *
 * Step rows are fail-closed inspection/accounting records for inline mutation progress.
 * They are intentionally not a resumable job queue.
 */
export class CapsuleBranchOperationStepStore {
  constructor(private readonly db: CapsuleHostDbContract) {}

  public async listStepsForOperation(operationId: string) {
    return await this.db.query.capsuleBranchOperationSteps.findMany({
      where: {
        operationId,
      },
      orderBy: (capsuleBranchOperationSteps, { asc }) => [asc(capsuleBranchOperationSteps.createdAt)],
    })
  }

  public async findStep(operationId: string, stepKey: string) {
    return await this.db.query.capsuleBranchOperationSteps.findFirst({
      where: {
        operationId,
        stepKey,
      },
    })
  }

  /**
   * Ensures a deterministic step row exists for an operation.
   *
   * This is idempotent for retry races and durable inspection. Callers still execute
   * the inline step body every time they invoke the executor.
   */
  public async ensureStep(input: BranchOperationStepInput): Promise<string> {
    const existing = await this.findStep(input.operationId, input.stepKey)
    if (existing) {
      return existing.id
    }

    try {
      return await this.createStep(input)
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error
      }

      const raced = await this.findStep(input.operationId, input.stepKey)
      if (raced) {
        return raced.id
      }

      throw new IncusError('Capsule branch operation step was created concurrently but could not be reloaded.', 'API_ERROR', {
        operationId: input.operationId,
        stepKey: input.stepKey,
      })
    }
  }

  public async createStep(input: BranchOperationStepInput): Promise<string> {
    const [step] = await this.db
      .insert(capsuleBranchOperationStepsTable)
      .values({
        operationId: input.operationId,
        ownerId: input.ownerId,
        branchId: input.branchId,
        branchName: input.branchName,
        stepKey: input.stepKey,
        status: input.status ?? CapsuleBranchOperationStepStatus.PENDING,
        metadata: input.metadata === undefined ? undefined : toJsonObject(input.metadata, 'capsule branch operation step metadata'),
        updatedAt: new Date(),
      })
      .returning({
        id: capsuleBranchOperationStepsTable.id,
      })
    if (!step) {
      throw new IncusError('Failed to record capsule branch operation step.', 'API_ERROR')
    }
    return step.id
  }

  public async markStepRunning(stepId: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.transitionStepStatus(stepId, CapsuleBranchOperationStepStatus.RUNNING, metadata)
  }

  public async markStepCompleted(stepId: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.transitionStepStatus(stepId, CapsuleBranchOperationStepStatus.COMPLETED, metadata)
  }

  public async transitionStepStatus(
    stepId: string,
    status: CapsuleBranchOperationStepStatusValue,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const now = new Date()
    const updateData: {
      status: CapsuleBranchOperationStepStatusValue
      metadata?: Record<string, unknown>
      startedAt?: Date
      completedAt?: Date
      failedAt?: Date
      updatedAt: Date
    } = {
      status,
      updatedAt: now,
    }
    if (metadata !== undefined) {
      updateData.metadata = toJsonObject(metadata, 'capsule branch operation step metadata')
    }
    if (status === CapsuleBranchOperationStepStatus.RUNNING) {
      updateData.startedAt = now
    }
    if (status === CapsuleBranchOperationStepStatus.COMPLETED || status === CapsuleBranchOperationStepStatus.SKIPPED) {
      updateData.completedAt = now
    }
    if (status === CapsuleBranchOperationStepStatus.FAILED) {
      updateData.failedAt = now
    }
    await this.db.update(capsuleBranchOperationStepsTable).set(updateData).where(eq(capsuleBranchOperationStepsTable.id, stepId))
  }

  public async markStepFailure(stepId: string, error: unknown, context?: Record<string, unknown>): Promise<void> {
    const details = createFailureDetails(error, context)
    const now = new Date()
    await this.db
      .update(capsuleBranchOperationStepsTable)
      .set({
        status: CapsuleBranchOperationStepStatus.FAILED,
        failedAt: now,
        updatedAt: now,
        failureCode: failureCodeFromUnknown(error),
        failureMessage: failureMessageFromUnknown(error, 'Unknown capsule branch operation step failure.'),
        failureDetails: details === undefined ? undefined : toJsonObject(details, 'capsule branch operation step failure details'),
      })
      .where(eq(capsuleBranchOperationStepsTable.id, stepId))
  }
}
