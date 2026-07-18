import { and, asc, eq, inArray } from 'drizzle-orm'
import { CapsuleOperationStepStatus, capsuleOperationStepsTable, type CapsuleHostDbContract } from '@qiln/core/server'
import { IncusError, isUniqueConstraintViolation } from '../../../../errors'
import {
  createFailureDetails as createOperationFailureDetails,
  failureCodeFromUnknown as operationFailureCodeFromUnknown,
  failureMessageFromUnknown as operationFailureMessageFromUnknown,
} from '../../failures'
import { toJsonObject } from '../../persistence/json'
import type { AbandonedOperationStepFailureInput, CapsuleOperationStepInput } from './types'

const ABANDONED_STEP_ELIGIBLE_STATUSES = [CapsuleOperationStepStatus.PENDING, CapsuleOperationStepStatus.RUNNING] as const

/**
 * Persistence boundary for operation-step accounting.
 *
 * Step rows are durable inspection records. They are not resumable checkpoints,
 * queue jobs, leases, retries, or authority to skip existing work.
 */
export class CapsuleOperationStepStore {
  constructor(private readonly db: CapsuleHostDbContract) {}

  public async listStepsForOperation(operationId: string) {
    return await this.db
      .select()
      .from(capsuleOperationStepsTable)
      .where(eq(capsuleOperationStepsTable.operationId, operationId))
      .orderBy(asc(capsuleOperationStepsTable.createdAt), asc(capsuleOperationStepsTable.id))
  }

  public async findStep(operationId: string, stepKey: string) {
    const [step] = await this.db
      .select()
      .from(capsuleOperationStepsTable)
      .where(and(eq(capsuleOperationStepsTable.operationId, operationId), eq(capsuleOperationStepsTable.stepKey, stepKey)))
      .limit(1)

    return step ?? null
  }

  /**
   * Ensures the accounting row exists.
   *
   * Finding an existing row does not imply that its action should be skipped,
   * resumed, retried, or replayed.
   */
  public async ensureStep(input: CapsuleOperationStepInput): Promise<string> {
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

      throw new IncusError('Capsule operation step was created concurrently but could not be reloaded.', 'API_ERROR', {
        operationId: input.operationId,
        capsuleId: input.capsuleId,
        stepKey: input.stepKey,
      })
    }
  }

  public async createStep(input: CapsuleOperationStepInput): Promise<string> {
    const [step] = await this.db
      .insert(capsuleOperationStepsTable)
      .values({
        operationId: input.operationId,
        capsuleId: input.capsuleId,
        ownerId: input.ownerId,
        branchId: input.branchId ?? null,
        branchName: input.branchName ?? null,
        stepKey: input.stepKey,
        status: input.status ?? CapsuleOperationStepStatus.PENDING,
        metadata: input.metadata === undefined ? undefined : toJsonObject(input.metadata, 'capsule operation step metadata'),
        updatedAt: new Date(),
      })
      .returning({
        id: capsuleOperationStepsTable.id,
      })

    if (!step) {
      throw new IncusError('Failed to record capsule operation step.', 'API_ERROR', {
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
      status: typeof CapsuleOperationStepStatus.RUNNING
      startedAt: Date
      completedAt: null
      failedAt: null
      failureCode: null
      failureMessage: null
      failureDetails: null
      updatedAt: Date
      metadata?: Record<string, unknown>
    } = {
      status: CapsuleOperationStepStatus.RUNNING,
      startedAt: now,
      completedAt: null,
      failedAt: null,
      failureCode: null,
      failureMessage: null,
      failureDetails: null,
      updatedAt: now,
    }

    if (metadata !== undefined) {
      updateData.metadata = toJsonObject(metadata, 'capsule operation step metadata')
    }

    const transitioned = await this.db
      .update(capsuleOperationStepsTable)
      .set(updateData)
      .where(and(eq(capsuleOperationStepsTable.id, stepId), eq(capsuleOperationStepsTable.status, CapsuleOperationStepStatus.PENDING)))
      .returning({
        id: capsuleOperationStepsTable.id,
      })

    if (transitioned.length !== 1) {
      throw new IncusError('Failed to persist capsule operation step running state.', 'CONFLICT', {
        stepId,
      })
    }
  }

  public async markStepCompleted(stepId: string, metadata?: Record<string, unknown>): Promise<void> {
    const now = new Date()
    const updateData: {
      status: typeof CapsuleOperationStepStatus.COMPLETED
      completedAt: Date
      updatedAt: Date
      metadata?: Record<string, unknown>
    } = {
      status: CapsuleOperationStepStatus.COMPLETED,
      completedAt: now,
      updatedAt: now,
    }

    if (metadata !== undefined) {
      updateData.metadata = toJsonObject(metadata, 'capsule operation step metadata')
    }

    const transitioned = await this.db
      .update(capsuleOperationStepsTable)
      .set(updateData)
      .where(and(eq(capsuleOperationStepsTable.id, stepId), eq(capsuleOperationStepsTable.status, CapsuleOperationStepStatus.RUNNING)))
      .returning({
        id: capsuleOperationStepsTable.id,
      })

    if (transitioned.length !== 1) {
      throw new IncusError('Failed to persist capsule operation step completion.', 'CONFLICT', {
        stepId,
      })
    }
  }

  public async markStepFailed(stepId: string, error: unknown, context?: Record<string, unknown>): Promise<void> {
    const now = new Date()
    const details = createOperationFailureDetails(error, context)

    const transitioned = await this.db
      .update(capsuleOperationStepsTable)
      .set({
        status: CapsuleOperationStepStatus.FAILED,
        failedAt: now,
        updatedAt: now,
        failureCode: operationFailureCodeFromUnknown(error),
        failureMessage: operationFailureMessageFromUnknown(error, 'Unknown capsule operation step failure.'),
        failureDetails: details === undefined ? undefined : toJsonObject(details, 'capsule operation step failure details'),
      })
      .where(and(eq(capsuleOperationStepsTable.id, stepId), eq(capsuleOperationStepsTable.status, CapsuleOperationStepStatus.RUNNING)))
      .returning({
        id: capsuleOperationStepsTable.id,
      })

    if (transitioned.length !== 1) {
      throw new IncusError('Failed to persist capsule operation step failure.', 'CONFLICT', {
        stepId,
      })
    }
  }

  /**
   * Marks remaining nonterminal step rows failed after an abandoned operation's
   * aggregate classification transaction has committed.
   *
   * Callers must not roll back or alter aggregate classification if this
   * accounting update fails.
   */
  public async markNonterminalStepsFailedAfterAbandonedClassification(input: AbandonedOperationStepFailureInput): Promise<number> {
    const now = new Date()
    const details = toJsonObject(
      {
        context: input.context,
      },
      'abandoned capsule operation step failure details',
    )

    const transitioned = await this.db
      .update(capsuleOperationStepsTable)
      .set({
        status: CapsuleOperationStepStatus.FAILED,
        failedAt: now,
        updatedAt: now,
        failureCode: input.failureCode,
        failureMessage: input.failureMessage,
        failureDetails: details,
      })
      .where(
        and(
          eq(capsuleOperationStepsTable.operationId, input.operationId),
          inArray(capsuleOperationStepsTable.status, ABANDONED_STEP_ELIGIBLE_STATUSES),
        ),
      )
      .returning({
        id: capsuleOperationStepsTable.id,
      })

    return transitioned.length
  }

  private assertExistingStepIdentity(
    existing: {
      capsuleId: string
      ownerId: string
      branchId: string | null
      branchName: string | null
    },
    input: CapsuleOperationStepInput,
  ): void {
    if (
      existing.capsuleId !== input.capsuleId ||
      existing.ownerId !== input.ownerId ||
      existing.branchId !== (input.branchId ?? null) ||
      existing.branchName !== (input.branchName ?? null)
    ) {
      throw new IncusError('Existing capsule operation step identity does not match the requested accounting boundary.', 'CONFLICT', {
        operationId: input.operationId,
        capsuleId: input.capsuleId,
        stepKey: input.stepKey,
      })
    }
  }
}
