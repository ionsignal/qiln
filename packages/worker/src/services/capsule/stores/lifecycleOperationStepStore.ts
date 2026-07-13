import { and, eq } from 'drizzle-orm'
import {
  CapsuleLifecycleOperationStepStatus,
  capsuleLifecycleOperationStepsTable,
  type CapsuleHostDbContract,
  type CapsuleLifecycleOperationStepStatusValue,
} from '@qiln/core/server'
import { IncusError, isUniqueConstraintViolation } from '../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from './errorDetails'
import { toJsonObject } from './jsonPersistence'
import type { LifecycleOperationStepInput } from './types'

/**
 * Persistence boundary for deterministic capsule lifecycle-operation steps.
 *
 * Step rows are fail-closed inspection records for inline mutation progress. They are not a resumable
 * job queue and never authorize replay of provider mutations after process loss.
 */
export class CapsuleLifecycleOperationStepStore {
  constructor(private readonly db: CapsuleHostDbContract) {}

  public async listStepsForOperation(operationId: string) {
    return await this.db.query.capsuleLifecycleOperationSteps.findMany({
      where: {
        operationId,
      },
      orderBy: (steps, { asc }) => [asc(steps.createdAt)],
    })
  }

  public async findStep(operationId: string, stepKey: string) {
    return await this.db.query.capsuleLifecycleOperationSteps.findFirst({
      where: {
        operationId,
        stepKey,
      },
    })
  }

  /**
   * Ensures the durable accounting row exists. Finding an existing row does not imply that its
   * ction should be skipped or resumed.
   */
  public async ensureStep(input: LifecycleOperationStepInput): Promise<string> {
    const existing = await this.findStep(input.operationId, input.stepKey)
    if (existing) {
      this.assertExistingStepIdentity(existing, input)
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
        this.assertExistingStepIdentity(raced, input)
        return raced.id
      }
      throw new IncusError('Capsule lifecycle step was created concurrently but could not be reloaded.', 'API_ERROR', {
        operationId: input.operationId,
        capsuleId: input.capsuleId,
        stepKey: input.stepKey,
      })
    }
  }

  public async createStep(input: LifecycleOperationStepInput): Promise<string> {
    const [step] = await this.db
      .insert(capsuleLifecycleOperationStepsTable)
      .values({
        operationId: input.operationId,
        capsuleId: input.capsuleId,
        ownerId: input.ownerId,
        branchId: input.branchId ?? null,
        branchName: input.branchName ?? null,
        stepKey: input.stepKey,
        status: input.status ?? CapsuleLifecycleOperationStepStatus.PENDING,
        metadata: input.metadata === undefined ? undefined : toJsonObject(input.metadata, 'capsule lifecycle step metadata'),
        updatedAt: new Date(),
      })
      .returning({
        id: capsuleLifecycleOperationStepsTable.id,
      })
    if (!step) {
      throw new IncusError('Failed to record capsule lifecycle step.', 'API_ERROR', {
        operationId: input.operationId,
        capsuleId: input.capsuleId,
        stepKey: input.stepKey,
      })
    }
    return step.id
  }

  public async markStepRunning(stepId: string, metadata?: Record<string, unknown>): Promise<void> {
    const now = new Date()
    const updateData: {
      status: typeof CapsuleLifecycleOperationStepStatus.RUNNING
      startedAt: Date
      completedAt: null
      failedAt: null
      failureCode: null
      failureMessage: null
      failureDetails: null
      updatedAt: Date
      metadata?: Record<string, unknown>
    } = {
      status: CapsuleLifecycleOperationStepStatus.RUNNING,
      startedAt: now,
      completedAt: null,
      failedAt: null,
      failureCode: null,
      failureMessage: null,
      failureDetails: null,
      updatedAt: now,
    }
    if (metadata !== undefined) {
      updateData.metadata = toJsonObject(metadata, 'capsule lifecycle step metadata')
    }
    const transitioned = await this.db
      .update(capsuleLifecycleOperationStepsTable)
      .set(updateData)
      .where(
        and(
          eq(capsuleLifecycleOperationStepsTable.id, stepId),
          eq(capsuleLifecycleOperationStepsTable.status, CapsuleLifecycleOperationStepStatus.PENDING),
        ),
      )
      .returning({
        id: capsuleLifecycleOperationStepsTable.id,
      })
    if (transitioned.length !== 1) {
      throw new IncusError('Failed to persist capsule lifecycle step running state.', 'CONFLICT', {
        stepId,
      })
    }
  }

  public async markStepCompleted(stepId: string, metadata?: Record<string, unknown>): Promise<void> {
    const now = new Date()
    const updateData: {
      status: typeof CapsuleLifecycleOperationStepStatus.COMPLETED
      completedAt: Date
      updatedAt: Date
      metadata?: Record<string, unknown>
    } = {
      status: CapsuleLifecycleOperationStepStatus.COMPLETED,
      completedAt: now,
      updatedAt: now,
    }
    if (metadata !== undefined) {
      updateData.metadata = toJsonObject(metadata, 'capsule lifecycle step metadata')
    }
    const transitioned = await this.db
      .update(capsuleLifecycleOperationStepsTable)
      .set(updateData)
      .where(
        and(
          eq(capsuleLifecycleOperationStepsTable.id, stepId),
          eq(capsuleLifecycleOperationStepsTable.status, CapsuleLifecycleOperationStepStatus.RUNNING),
        ),
      )
      .returning({
        id: capsuleLifecycleOperationStepsTable.id,
      })

    if (transitioned.length !== 1) {
      throw new IncusError('Failed to persist capsule lifecycle step completion.', 'CONFLICT', {
        stepId,
      })
    }
  }

  public async transitionStepStatus(stepId: string, status: CapsuleLifecycleOperationStepStatusValue): Promise<void> {
    const now = new Date()
    const updateData: {
      status: CapsuleLifecycleOperationStepStatusValue
      startedAt?: Date
      completedAt?: Date
      failedAt?: Date
      updatedAt: Date
    } = {
      status,
      updatedAt: now,
    }
    if (status === CapsuleLifecycleOperationStepStatus.RUNNING) {
      updateData.startedAt = now
    }
    if (status === CapsuleLifecycleOperationStepStatus.COMPLETED) {
      updateData.completedAt = now
    }
    if (status === CapsuleLifecycleOperationStepStatus.FAILED) {
      updateData.failedAt = now
    }
    const transitioned = await this.db
      .update(capsuleLifecycleOperationStepsTable)
      .set(updateData)
      .where(eq(capsuleLifecycleOperationStepsTable.id, stepId))
      .returning({
        id: capsuleLifecycleOperationStepsTable.id,
      })
    if (transitioned.length !== 1) {
      throw new IncusError('Capsule lifecycle step was not found while changing its status.', 'NOT_FOUND', {
        stepId,
        status,
      })
    }
  }

  public async markStepFailure(stepId: string, error: unknown, context?: Record<string, unknown>): Promise<void> {
    const details = createFailureDetails(error, context)
    const now = new Date()
    const transitioned = await this.db
      .update(capsuleLifecycleOperationStepsTable)
      .set({
        status: CapsuleLifecycleOperationStepStatus.FAILED,
        failedAt: now,
        updatedAt: now,
        failureCode: failureCodeFromUnknown(error),
        failureMessage: failureMessageFromUnknown(error, 'Unknown capsule lifecycle step failure.'),
        failureDetails: details === undefined ? undefined : toJsonObject(details, 'capsule lifecycle step failure details'),
      })
      .where(
        and(
          eq(capsuleLifecycleOperationStepsTable.id, stepId),
          eq(capsuleLifecycleOperationStepsTable.status, CapsuleLifecycleOperationStepStatus.RUNNING),
        ),
      )
      .returning({
        id: capsuleLifecycleOperationStepsTable.id,
      })
    if (transitioned.length !== 1) {
      throw new IncusError('Failed to persist capsule lifecycle step failure.', 'CONFLICT', {
        stepId,
      })
    }
  }

  private assertExistingStepIdentity(
    existing: {
      capsuleId: string
      ownerId: string
      branchId: string | null
      branchName: string | null
    },
    input: LifecycleOperationStepInput,
  ): void {
    if (
      existing.capsuleId !== input.capsuleId ||
      existing.ownerId !== input.ownerId ||
      existing.branchId !== (input.branchId ?? null) ||
      existing.branchName !== (input.branchName ?? null)
    ) {
      throw new IncusError('Existing capsule lifecycle step identity does not match the requested accounting boundary.', 'CONFLICT', {
        operationId: input.operationId,
        capsuleId: input.capsuleId,
        stepKey: input.stepKey,
      })
    }
  }
}
