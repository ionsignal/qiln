import { eq } from 'drizzle-orm'
import {
  CapsuleBranchCreateOutputSchema,
  CapsuleBranchOperationStatus,
  CapsuleBranchOperationType,
  capsuleBranchesTable,
  capsuleBranchOperationsTable,
  type CapsuleBranchCreateOutput,
  type CapsuleBranchOperationStatus as CapsuleBranchOperationStatusValue,
  type CapsuleBranchStatus,
  type CapsuleHostDbContract,
} from '@qiln/core/server'
import { IncusError, isUniqueConstraintViolation } from '../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from './errorDetails'
import { toJsonObject } from './jsonPersistence'
import type { AcceptedBranchCreateOperation, AcceptBranchCreateOperationInput } from './types'

/**
 * Persistence boundary for durable capsule branch operations.
 *
 * This owns operation identity, idempotency replay, status transitions, and
 * failure recording. It intentionally does not own resource inventory or general
 * branch runtime transitions.
 */
export class CapsuleBranchOperationStore {
  constructor(private readonly db: CapsuleHostDbContract) {}

  public async findExistingBranchCreateOperationReceipt(
    ownerId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<CapsuleBranchCreateOutput | null> {
    const operation = await this.db.query.capsuleBranchOperations.findFirst({
      where: {
        ownerId,
        idempotencyKey,
        type: CapsuleBranchOperationType.CREATE,
      },
      columns: {
        id: true,
        status: true,
        requestHash: true,
        branchName: true,
      },
    })
    if (!operation) {
      return null
    }
    if (operation.requestHash !== requestHash) {
      throw new IncusError('Idempotency key was already used with different capsule branch create input.', 'CONFLICT', {
        idempotencyKey,
      })
    }
    const branch = await this.db.query.capsuleBranches.findFirst({
      where: {
        ownerId,
        name: operation.branchName,
      },
      columns: {
        status: true,
      },
    })
    return this.createBranchCreateOutput(
      operation.id,
      operation.status,
      operation.branchName,
      branch?.status ?? this.fallbackBranchStatusForOperation(operation.status),
      true,
    )
  }

  public async acceptBranchCreateOperation(input: AcceptBranchCreateOperationInput): Promise<AcceptedBranchCreateOperation> {
    try {
      const now = new Date()
      return await this.db.transaction(async tx => {
        const [operation] = await tx
          .insert(capsuleBranchOperationsTable)
          .values({
            ownerId: input.ownerId,
            type: CapsuleBranchOperationType.CREATE,
            status: CapsuleBranchOperationStatus.ACCEPTED,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            branchName: input.name,
            blueprintName: input.blueprintName,
            blueprintDigest: input.blueprintDigest,
            blueprintSnapshot: input.blueprintSnapshot,
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: capsuleBranchOperationsTable.id,
          })
        if (!operation) {
          throw new IncusError('Failed to create durable capsule branch operation.', 'API_ERROR')
        }
        const [branch] = await tx
          .insert(capsuleBranchesTable)
          .values({
            ownerId: input.ownerId,
            name: input.name,
            blueprintName: input.blueprintName,
            blueprintDigest: input.blueprintDigest,
            cpu: input.cpu,
            memory: input.memory,
            status: 'provisioning',
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: capsuleBranchesTable.id,
          })
        if (!branch) {
          throw new IncusError('Failed to create capsule branch provisioning record.', 'API_ERROR')
        }
        const [runningOperation] = await tx
          .update(capsuleBranchOperationsTable)
          .set({
            branchId: branch.id,
            status: CapsuleBranchOperationStatus.RUNNING,
            startedAt: now,
            updatedAt: now,
          })
          .where(eq(capsuleBranchOperationsTable.id, operation.id))
          .returning({
            id: capsuleBranchOperationsTable.id,
          })
        if (!runningOperation) {
          throw new IncusError('Failed to mark capsule branch operation as running.', 'API_ERROR')
        }
        return {
          operationId: runningOperation.id,
          branchId: branch.id,
        }
      })
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error
      }
      const replayedReceipt = await this.findExistingBranchCreateOperationReceipt(input.ownerId, input.idempotencyKey, input.requestHash)
      if (replayedReceipt) {
        return {
          operationId: replayedReceipt.operationId,
          branchId: '',
          replayedReceipt,
        }
      }
      const existingBranch = await this.db.query.capsuleBranches.findFirst({
        where: {
          ownerId: input.ownerId,
          name: input.name,
        },
        columns: {
          id: true,
        },
      })
      if (existingBranch) {
        throw new IncusError(`Capsule branch '${input.name}' already exists.`, 'CONFLICT')
      }
      throw new IncusError('Capsule branch create operation conflicts with an existing durable operation.', 'CONFLICT')
    }
  }

  public async transitionBranchOperationStatus(operationId: string, status: CapsuleBranchOperationStatusValue): Promise<void> {
    const now = new Date()
    const updateData: {
      status: CapsuleBranchOperationStatusValue
      updatedAt: Date
      completedAt?: Date
      failedAt?: Date
    } = {
      status,
      updatedAt: now,
    }
    if (status === CapsuleBranchOperationStatus.COMPLETED) {
      updateData.completedAt = now
    }
    if (status === CapsuleBranchOperationStatus.FAILED || status === CapsuleBranchOperationStatus.CLEANUP_REQUIRED) {
      updateData.failedAt = now
    }
    await this.db.update(capsuleBranchOperationsTable).set(updateData).where(eq(capsuleBranchOperationsTable.id, operationId))
  }

  public async markBranchOperationFailure(
    operationId: string,
    status: CapsuleBranchOperationStatusValue,
    error: unknown,
    context?: Record<string, unknown>,
  ): Promise<void> {
    const details = createFailureDetails(error, context)
    const now = new Date()
    await this.db
      .update(capsuleBranchOperationsTable)
      .set({
        status,
        failedAt: now,
        updatedAt: now,
        failureCode: failureCodeFromUnknown(error),
        failureMessage: failureMessageFromUnknown(error, 'Unknown capsule branch operation failure.'),
        failureDetails: details === undefined ? undefined : toJsonObject(details, 'capsule branch operation failure details'),
      })
      .where(eq(capsuleBranchOperationsTable.id, operationId))
  }

  public createBranchCreateOutput(
    operationId: string,
    operationStatus: CapsuleBranchOperationStatusValue,
    branchName: string,
    branchStatus: CapsuleBranchStatus,
    replayed: boolean,
  ): CapsuleBranchCreateOutput {
    return CapsuleBranchCreateOutputSchema.parse({
      operationId,
      operationType: CapsuleBranchOperationType.CREATE,
      operationStatus,
      branchName,
      branchStatus,
      replayed,
    })
  }

  private fallbackBranchStatusForOperation(status: CapsuleBranchOperationStatusValue): CapsuleBranchStatus {
    switch (status) {
      case CapsuleBranchOperationStatus.COMPLETED:
        return 'offline'
      case CapsuleBranchOperationStatus.RECOVERING:
        return 'recovering'
      case CapsuleBranchOperationStatus.CLEANUP_REQUIRED:
        return 'cleanup_required'
      case CapsuleBranchOperationStatus.FAILED:
        return 'error'
      case CapsuleBranchOperationStatus.ACCEPTED:
      case CapsuleBranchOperationStatus.RUNNING:
      default:
        return 'provisioning'
    }
  }
}
