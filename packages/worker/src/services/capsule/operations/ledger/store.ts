import { and, eq, inArray } from 'drizzle-orm'
import {
  CapsuleBranchCreateOutputSchema,
  CapsuleBranchOperationStatus,
  CapsuleBranchOperationType,
  capsuleBranchesTable,
  capsuleBranchOperationsTable,
  capsuleBranchResourcesTable,
  type CapsuleBranchCreateOutput,
  type CapsuleBranchOperationStatus as CapsuleBranchOperationStatusValue,
  type CapsuleBranchResourceStatus as CapsuleBranchResourceStatusValue,
  type CapsuleBranchStatus,
  type CapsuleHostDbContract,
} from '@qiln/core/server'
import { IncusError, isUniqueConstraintViolation } from '../../../../errors'
import { detailsFromUnknown } from './errorDetails'
import { toJsonObject } from './jsonPersistence'
import type { AcceptedBranchCreateOperation, AcceptBranchCreateOperationInput, BranchResourceInput, ReconcileBranch } from './types'

/**
 * Centralized durable branch operation/resource persistence.
 *
 * This store intentionally also owns the branch read-model transitions for now so
 * saga code cannot scatter raw Drizzle state-machine updates. A later recovery PR
 * can split the branch read model once recovery semantics are clearer.
 */
export class CapsuleBranchOperationLedgerStore {
  constructor(private readonly db: CapsuleHostDbContract) {}

  public async listBranches(ownerId: string) {
    return await this.db.query.capsuleBranches.findMany({
      where: { ownerId },
      orderBy: (capsuleBranches, { desc }) => [desc(capsuleBranches.createdAt)],
    })
  }

  public async findBranch(ownerId: string, name: string) {
    return await this.db.query.capsuleBranches.findFirst({
      where: { name, ownerId },
    })
  }

  public async listBranchesForReconcile(): Promise<ReconcileBranch[]> {
    const rows = await this.db.query.capsuleBranches.findMany({
      columns: { name: true, ownerId: true, status: true },
    })
    return rows
  }

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

  public async createBranchResource(input: BranchResourceInput): Promise<string> {
    const [resource] = await this.db
      .insert(capsuleBranchResourcesTable)
      .values({
        createdByOperationId: input.operationId,
        lastOperationId: input.operationId,
        ownerId: input.ownerId,
        branchId: input.branchId,
        branchName: input.branchName,
        resourceType: input.resourceType,
        resourceKey: input.resourceKey,
        cleanupPolicy: input.cleanupPolicy,
        status: input.status ?? 'planned',
        metadata: input.metadata === undefined ? undefined : toJsonObject(input.metadata, 'capsule branch resource metadata'),
        updatedAt: new Date(),
      })
      .returning({
        id: capsuleBranchResourcesTable.id,
      })
    if (!resource) {
      throw new IncusError('Failed to record capsule branch resource.', 'API_ERROR')
    }
    return resource.id
  }

  public async transitionBranchResourceStatus(
    resourceId: string,
    status: CapsuleBranchResourceStatusValue,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const updateData: {
      status: CapsuleBranchResourceStatusValue
      metadata?: Record<string, unknown>
      updatedAt: Date
    } = {
      status,
      updatedAt: new Date(),
    }
    if (metadata !== undefined) {
      updateData.metadata = toJsonObject(metadata, 'capsule branch resource metadata')
    }
    await this.db.update(capsuleBranchResourcesTable).set(updateData).where(eq(capsuleBranchResourcesTable.id, resourceId))
  }

  public async markBranchResourceError(resourceId: string, error: unknown): Promise<void> {
    const details = detailsFromUnknown(error)
    await this.db
      .update(capsuleBranchResourcesTable)
      .set({
        status: 'error',
        updatedAt: new Date(),
        failureCode: error instanceof IncusError ? error.code : 'UNKNOWN',
        failureMessage: error instanceof Error ? error.message : 'Unknown capsule branch resource failure.',
        failureDetails: details === undefined ? undefined : toJsonObject(details, 'capsule branch resource failure details'),
      })
      .where(eq(capsuleBranchResourcesTable.id, resourceId))
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

  public async markBranchOperationFailure(operationId: string, status: CapsuleBranchOperationStatusValue, error: unknown): Promise<void> {
    const details = detailsFromUnknown(error)
    const now = new Date()
    await this.db
      .update(capsuleBranchOperationsTable)
      .set({
        status,
        failedAt: now,
        updatedAt: now,
        failureCode: error instanceof IncusError ? error.code : 'UNKNOWN',
        failureMessage: error instanceof Error ? error.message : 'Unknown capsule branch operation failure.',
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

  public async transitionBranchState(ownerId: string, name: string, status: CapsuleBranchStatus, ip?: string | null): Promise<void> {
    const updateData: {
      status: CapsuleBranchStatus
      runtimeIp?: string | null
      updatedAt: Date
    } = {
      status,
      updatedAt: new Date(),
    }
    if (ip !== undefined) {
      updateData.runtimeIp = ip
    }
    await this.db
      .update(capsuleBranchesTable)
      .set(updateData)
      .where(and(eq(capsuleBranchesTable.ownerId, ownerId), eq(capsuleBranchesTable.name, name)))
  }

  public async transitionBranchStateWhereStatus(
    ownerId: string,
    name: string,
    status: CapsuleBranchStatus,
    allowedStatuses: CapsuleBranchStatus[],
  ): Promise<boolean> {
    if (allowedStatuses.length === 0) {
      return false
    }
    const result = await this.db
      .update(capsuleBranchesTable)
      .set({
        status,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(capsuleBranchesTable.ownerId, ownerId),
          eq(capsuleBranchesTable.name, name),
          inArray(capsuleBranchesTable.status, allowedStatuses),
        ),
      )
      .returning({ id: capsuleBranchesTable.id })
    return result.length > 0
  }

  public async deleteBranch(ownerId: string, name: string): Promise<void> {
    await this.db.delete(capsuleBranchesTable).where(and(eq(capsuleBranchesTable.ownerId, ownerId), eq(capsuleBranchesTable.name, name)))
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
