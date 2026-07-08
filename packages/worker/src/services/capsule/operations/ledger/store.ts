import { and, eq, inArray } from 'drizzle-orm'
import {
  CapsuleBranchCreateOutputSchema,
  CapsuleOperationStatus,
  CapsuleOperationType,
  capsuleBranchesTable,
  capsuleOperationResourcesTable,
  capsuleOperationsTable,
  type CapsuleBranchCreateOutput,
  type CapsuleBranchStatus,
  type CapsuleHostDbContract,
  type CapsuleOperationResourceStatus as CapsuleOperationResourceStatusValue,
  type CapsuleOperationStatus as CapsuleOperationStatusValue,
} from '@qiln/core/server'
import { IncusError, isUniqueConstraintViolation } from '../../../../errors'
import { detailsFromUnknown } from './errorDetails'
import { toJsonObject } from './jsonPersistence'
import type { AcceptedCreateOperation, AcceptCreateOperationInput, OperationResourceInput, ReconcileBranch } from './types'

/**
 * Centralized durable operation/resource persistence for capsule branch mutations.
 *
 * This store intentionally also owns the branch read-model transitions for now so
 * saga code cannot scatter raw Drizzle state-machine updates. A later recovery PR
 * can split the branch read model once recovery semantics are clearer.
 */
export class CapsuleOperationLedgerStore {
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

  public async findExistingCreateOperationReceipt(
    ownerId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<CapsuleBranchCreateOutput | null> {
    const operation = await this.db.query.capsuleOperations.findFirst({
      where: {
        ownerId,
        idempotencyKey,
        type: CapsuleOperationType.BRANCH_CREATE,
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

  public async acceptCreateOperation(input: AcceptCreateOperationInput): Promise<AcceptedCreateOperation> {
    try {
      const now = new Date()
      return await this.db.transaction(async tx => {
        const [operation] = await tx
          .insert(capsuleOperationsTable)
          .values({
            ownerId: input.ownerId,
            type: CapsuleOperationType.BRANCH_CREATE,
            status: CapsuleOperationStatus.ACCEPTED,
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
            id: capsuleOperationsTable.id,
          })
        if (!operation) {
          throw new IncusError('Failed to create durable capsule operation.', 'API_ERROR')
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
          .update(capsuleOperationsTable)
          .set({
            branchId: branch.id,
            status: CapsuleOperationStatus.RUNNING,
            startedAt: now,
            updatedAt: now,
          })
          .where(eq(capsuleOperationsTable.id, operation.id))
          .returning({
            id: capsuleOperationsTable.id,
          })
        if (!runningOperation) {
          throw new IncusError('Failed to mark capsule operation as running.', 'API_ERROR')
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
      const replayedReceipt = await this.findExistingCreateOperationReceipt(input.ownerId, input.idempotencyKey, input.requestHash)
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

  public async createOperationResource(input: OperationResourceInput): Promise<string> {
    const [resource] = await this.db
      .insert(capsuleOperationResourcesTable)
      .values({
        operationId: input.operationId,
        ownerId: input.ownerId,
        branchId: input.branchId,
        branchName: input.branchName,
        resourceType: input.resourceType,
        resourceKey: input.resourceKey,
        cleanupPolicy: input.cleanupPolicy,
        status: input.status ?? 'planned',
        metadata: input.metadata === undefined ? undefined : toJsonObject(input.metadata, 'capsule operation resource metadata'),
        updatedAt: new Date(),
      })
      .returning({
        id: capsuleOperationResourcesTable.id,
      })
    if (!resource) {
      throw new IncusError('Failed to record capsule operation resource.', 'API_ERROR')
    }
    return resource.id
  }

  public async transitionResourceStatus(
    resourceId: string,
    status: CapsuleOperationResourceStatusValue,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const updateData: {
      status: CapsuleOperationResourceStatusValue
      metadata?: Record<string, unknown>
      updatedAt: Date
    } = {
      status,
      updatedAt: new Date(),
    }
    if (metadata !== undefined) {
      updateData.metadata = toJsonObject(metadata, 'capsule operation resource metadata')
    }
    await this.db.update(capsuleOperationResourcesTable).set(updateData).where(eq(capsuleOperationResourcesTable.id, resourceId))
  }

  public async markResourceError(resourceId: string, error: unknown): Promise<void> {
    await this.transitionResourceStatus(resourceId, 'error', {
      error: detailsFromUnknown(error),
    })
  }

  public async transitionOperationStatus(operationId: string, status: CapsuleOperationStatusValue): Promise<void> {
    const now = new Date()
    const updateData: {
      status: CapsuleOperationStatusValue
      updatedAt: Date
      completedAt?: Date
      failedAt?: Date
    } = {
      status,
      updatedAt: now,
    }
    if (status === CapsuleOperationStatus.COMPLETED) {
      updateData.completedAt = now
    }
    if (status === CapsuleOperationStatus.FAILED || status === CapsuleOperationStatus.CLEANUP_REQUIRED) {
      updateData.failedAt = now
    }
    await this.db.update(capsuleOperationsTable).set(updateData).where(eq(capsuleOperationsTable.id, operationId))
  }

  public async markOperationFailure(operationId: string, status: CapsuleOperationStatusValue, error: unknown): Promise<void> {
    const details = detailsFromUnknown(error)
    const now = new Date()
    await this.db
      .update(capsuleOperationsTable)
      .set({
        status,
        failedAt: now,
        updatedAt: now,
        failureCode: error instanceof IncusError ? error.code : 'UNKNOWN',
        failureMessage: error instanceof Error ? error.message : 'Unknown capsule operation failure.',
        failureDetails: details === undefined ? undefined : toJsonObject(details, 'capsule operation failure details'),
      })
      .where(eq(capsuleOperationsTable.id, operationId))
  }

  public createBranchCreateOutput(
    operationId: string,
    operationStatus: CapsuleOperationStatusValue,
    branchName: string,
    branchStatus: CapsuleBranchStatus,
    replayed: boolean,
  ): CapsuleBranchCreateOutput {
    return CapsuleBranchCreateOutputSchema.parse({
      operationId,
      operationType: CapsuleOperationType.BRANCH_CREATE,
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

  private fallbackBranchStatusForOperation(status: CapsuleOperationStatusValue): CapsuleBranchStatus {
    switch (status) {
      case CapsuleOperationStatus.COMPLETED:
        return 'offline'
      case CapsuleOperationStatus.RECOVERING:
        return 'recovering'
      case CapsuleOperationStatus.CLEANUP_REQUIRED:
        return 'cleanup_required'
      case CapsuleOperationStatus.FAILED:
        return 'error'
      case CapsuleOperationStatus.ACCEPTED:
      case CapsuleOperationStatus.RUNNING:
      default:
        return 'provisioning'
    }
  }
}
