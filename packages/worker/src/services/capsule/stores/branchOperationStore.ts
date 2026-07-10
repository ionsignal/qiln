import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  CapsuleBranchCreateOutputSchema,
  CapsuleBranchDeleteOutputSchema,
  CapsuleBranchOperationStatus,
  CapsuleBranchOperationType,
  capsuleBranchesTable,
  capsuleBranchOperationsTable,
  type CapsuleBranchCreateOutput,
  type CapsuleBranchDeleteOutput,
  type CapsuleBranchOperationStatusValue,
  type CapsuleBranchStatus,
  type CapsuleHostDbContract,
} from '@qiln/core/server'
import { IncusError, isUniqueConstraintViolation } from '../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from './errorDetails'
import { toJsonObject } from './jsonPersistence'
import type {
  AbandonedBranchCreateOperationCandidate,
  AbandonedBranchDeleteOperationCandidate,
  AcceptedBranchCreateOperation,
  AcceptedBranchDeleteOperation,
  AcceptBranchCreateOperationInput,
  AcceptBranchDeleteOperationInput,
} from './types'

const NON_TERMINAL_BRANCH_OPERATION_STATUSES = [CapsuleBranchOperationStatus.ACCEPTED, CapsuleBranchOperationStatus.RUNNING] as const

const DELETE_BLOCKED_BRANCH_STATUSES: ReadonlySet<CapsuleBranchStatus> = new Set([
  'provisioning',
  'recovering',
  'starting',
  'stopping',
  'deleting',
])

/**
 * Persistence boundary for durable capsule branch operations.
 *
 * This owns operation identity, idempotency replay, status transitions, and failure recording.
 * It intentionally does not own resource inventory or general branch runtime transitions.
 */
export class CapsuleBranchOperationStore {
  constructor(private readonly db: CapsuleHostDbContract) {}

  public async findExistingBranchCreateOperationReceipt(
    ownerId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<CapsuleBranchCreateOutput | null> {
    const operation = await this.findOperationByOwnerIdempotencyKey(ownerId, idempotencyKey)
    if (!operation) {
      return null
    }
    if (operation.type !== CapsuleBranchOperationType.CREATE) {
      throw new IncusError('Idempotency key was already used with a different capsule branch operation type.', 'CONFLICT', {
        idempotencyKey,
        existingOperationType: operation.type,
        requestedOperationType: CapsuleBranchOperationType.CREATE,
      })
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

  public async findExistingBranchDeleteOperationReceipt(
    ownerId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<CapsuleBranchDeleteOutput | null> {
    const operation = await this.findOperationByOwnerIdempotencyKey(ownerId, idempotencyKey)
    if (!operation) {
      return null
    }
    if (operation.type !== CapsuleBranchOperationType.DELETE) {
      throw new IncusError('Idempotency key was already used with a different capsule branch operation type.', 'CONFLICT', {
        idempotencyKey,
        existingOperationType: operation.type,
        requestedOperationType: CapsuleBranchOperationType.DELETE,
      })
    }
    if (operation.requestHash !== requestHash) {
      throw new IncusError('Idempotency key was already used with different capsule branch delete input.', 'CONFLICT', {
        idempotencyKey,
      })
    }
    const branch = await this.db.query.capsuleBranches.findFirst({
      where: {
        ownerId,
        name: operation.branchName,
      },
      columns: {
        id: true,
      },
    })
    return this.createBranchDeleteOutput(operation.id, operation.status, operation.branchName, !branch, true)
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

  public async acceptBranchDeleteOperation(input: AcceptBranchDeleteOperationInput): Promise<AcceptedBranchDeleteOperation> {
    try {
      const now = new Date()
      return await this.db.transaction(async tx => {
        const [operation] = await tx
          .insert(capsuleBranchOperationsTable)
          .values({
            ownerId: input.ownerId,
            type: CapsuleBranchOperationType.DELETE,
            status: CapsuleBranchOperationStatus.ACCEPTED,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            branchName: input.name,
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: capsuleBranchOperationsTable.id,
          })
        if (!operation) {
          throw new IncusError('Failed to create durable capsule branch delete operation.', 'API_ERROR')
        }
        const [branch] = await tx
          .select({
            id: capsuleBranchesTable.id,
            status: capsuleBranchesTable.status,
            resourceInventoryDigest: capsuleBranchesTable.resourceInventoryDigest,
          })
          .from(capsuleBranchesTable)
          .where(and(eq(capsuleBranchesTable.ownerId, input.ownerId), eq(capsuleBranchesTable.name, input.name)))
          .limit(1)
        if (!branch) {
          throw new IncusError('Capsule branch not found or access denied.', 'NOT_FOUND')
        }
        if (DELETE_BLOCKED_BRANCH_STATUSES.has(branch.status)) {
          throw new IncusError('Capsule branch cannot be deleted while another lifecycle transition is in progress.', 'CONFLICT', {
            branchName: input.name,
            status: branch.status,
          })
        }
        const [transitionedBranch] = await tx
          .update(capsuleBranchesTable)
          .set({
            status: 'deleting',
            updatedAt: now,
          })
          .where(and(eq(capsuleBranchesTable.id, branch.id), eq(capsuleBranchesTable.status, branch.status)))
          .returning({
            id: capsuleBranchesTable.id,
          })
        if (!transitionedBranch) {
          throw new IncusError('Capsule branch delete conflicted with a concurrent lifecycle transition.', 'CONFLICT', {
            branchName: input.name,
          })
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
          throw new IncusError('Failed to mark capsule branch delete operation as running.', 'API_ERROR')
        }
        return {
          operationId: runningOperation.id,
          branchId: branch.id,
          resourceInventoryDigest: branch.resourceInventoryDigest,
        }
      })
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error
      }
      const replayedReceipt = await this.findExistingBranchDeleteOperationReceipt(input.ownerId, input.idempotencyKey, input.requestHash)
      if (replayedReceipt) {
        return {
          operationId: replayedReceipt.operationId,
          branchId: '',
          resourceInventoryDigest: null,
          replayedReceipt,
        }
      }
      throw new IncusError('Capsule branch delete operation conflicts with an existing durable operation.', 'CONFLICT')
    }
  }

  /**
   * Finds inline branch-create operations that were left non-terminal by a worker crash or shutdown.
   * Startup marks them cleanup_required so operators can inspect and clean up uncertain resources.
   */
  public async listAbandonedBranchCreateOperationCandidates(): Promise<AbandonedBranchCreateOperationCandidate[]> {
    return await this.db
      .select({
        id: capsuleBranchOperationsTable.id,
        ownerId: capsuleBranchOperationsTable.ownerId,
        branchId: capsuleBranchOperationsTable.branchId,
        branchName: capsuleBranchOperationsTable.branchName,
        status: capsuleBranchOperationsTable.status,
        createdAt: capsuleBranchOperationsTable.createdAt,
        updatedAt: capsuleBranchOperationsTable.updatedAt,
      })
      .from(capsuleBranchOperationsTable)
      .where(
        and(
          eq(capsuleBranchOperationsTable.type, CapsuleBranchOperationType.CREATE),
          inArray(capsuleBranchOperationsTable.status, NON_TERMINAL_BRANCH_OPERATION_STATUSES),
        ),
      )
      .orderBy(asc(capsuleBranchOperationsTable.createdAt))
  }

  /**
   * Finds inline branch-delete operations that were left non-terminal by a worker crash or shutdown.
   * Startup marks them cleanup_required. It does not replay destructive delete steps.
   */
  public async listAbandonedBranchDeleteOperationCandidates(): Promise<AbandonedBranchDeleteOperationCandidate[]> {
    return await this.db
      .select({
        id: capsuleBranchOperationsTable.id,
        ownerId: capsuleBranchOperationsTable.ownerId,
        branchId: capsuleBranchOperationsTable.branchId,
        branchName: capsuleBranchOperationsTable.branchName,
        status: capsuleBranchOperationsTable.status,
        createdAt: capsuleBranchOperationsTable.createdAt,
        updatedAt: capsuleBranchOperationsTable.updatedAt,
      })
      .from(capsuleBranchOperationsTable)
      .where(
        and(
          eq(capsuleBranchOperationsTable.type, CapsuleBranchOperationType.DELETE),
          inArray(capsuleBranchOperationsTable.status, NON_TERMINAL_BRANCH_OPERATION_STATUSES),
        ),
      )
      .orderBy(asc(capsuleBranchOperationsTable.createdAt))
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

  public async markNonTerminalBranchOperationCleanupRequired(
    operationId: string,
    error: unknown,
    context?: Record<string, unknown>,
  ): Promise<boolean> {
    const details = createFailureDetails(error, context)
    const now = new Date()
    const result = await this.db
      .update(capsuleBranchOperationsTable)
      .set({
        status: CapsuleBranchOperationStatus.CLEANUP_REQUIRED,
        failedAt: now,
        updatedAt: now,
        failureCode: failureCodeFromUnknown(error),
        failureMessage: failureMessageFromUnknown(error, 'Capsule branch operation was abandoned before completion.'),
        failureDetails: details === undefined ? undefined : toJsonObject(details, 'capsule branch operation failure details'),
      })
      .where(
        and(
          eq(capsuleBranchOperationsTable.id, operationId),
          inArray(capsuleBranchOperationsTable.status, NON_TERMINAL_BRANCH_OPERATION_STATUSES),
        ),
      )
      .returning({
        id: capsuleBranchOperationsTable.id,
      })
    return result.length > 0
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

  public createBranchDeleteOutput(
    operationId: string,
    operationStatus: CapsuleBranchOperationStatusValue,
    branchName: string,
    branchDeleted: boolean,
    replayed: boolean,
  ): CapsuleBranchDeleteOutput {
    return CapsuleBranchDeleteOutputSchema.parse({
      ok: true,
      operationId,
      operationType: CapsuleBranchOperationType.DELETE,
      operationStatus,
      branchName,
      branchDeleted,
      replayed,
    })
  }

  private async findOperationByOwnerIdempotencyKey(ownerId: string, idempotencyKey: string) {
    return await this.db.query.capsuleBranchOperations.findFirst({
      where: {
        ownerId,
        idempotencyKey,
      },
      columns: {
        id: true,
        type: true,
        status: true,
        requestHash: true,
        branchName: true,
      },
    })
  }

  private fallbackBranchStatusForOperation(status: CapsuleBranchOperationStatusValue): CapsuleBranchStatus {
    switch (status) {
      case CapsuleBranchOperationStatus.COMPLETED:
        return 'offline'
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
