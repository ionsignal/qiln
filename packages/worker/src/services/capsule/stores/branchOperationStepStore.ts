import { eq } from 'drizzle-orm'
import {
  CapsuleBranchOperationStepStatus,
  capsuleBranchOperationStepsTable,
  type CapsuleBranchOperationStepStatus as CapsuleBranchOperationStepStatusValue,
  type CapsuleHostDbContract,
} from '@qiln/core/server'
import { IncusError } from '../../../errors'
import { detailsFromUnknown } from './errorDetails'
import { toJsonObject } from './jsonPersistence'
import type { BranchOperationStepInput } from './types'

/**
 * Persistence boundary for deterministic branch operation steps.
 *
 * PR 2 creates this seam without wiring step execution into the create saga yet.
 * PR 3 can add inline step execution on top of this store without reshaping DB
 * access again.
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

  public async markStepFailure(stepId: string, error: unknown): Promise<void> {
    const details = detailsFromUnknown(error)
    const now = new Date()
    await this.db
      .update(capsuleBranchOperationStepsTable)
      .set({
        status: CapsuleBranchOperationStepStatus.FAILED,
        failedAt: now,
        updatedAt: now,
        failureCode: error instanceof IncusError ? error.code : 'UNKNOWN',
        failureMessage: error instanceof Error ? error.message : 'Unknown capsule branch operation step failure.',
        failureDetails: details === undefined ? undefined : toJsonObject(details, 'capsule branch operation step failure details'),
      })
      .where(eq(capsuleBranchOperationStepsTable.id, stepId))
  }
}
