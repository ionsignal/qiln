import { and, eq } from 'drizzle-orm'
import {
  CapsuleBranchResourceStatus,
  capsuleBranchResourcesTable,
  type CapsuleBranchResourceStatusValue,
  type CapsuleHostDbContract,
} from '@qiln/core/server'
import { IncusError, isUniqueConstraintViolation } from '../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from './errorDetails'
import { toJsonObject } from './jsonPersistence'
import type { BranchResourceInput } from './types'

/**
 * Persistence boundary for branch-owned resources.
 *
 * Resource rows are the durable inventory of external/provider resources touched by branch operations.
 * Delete and fail-closed cleanup accounting should prefer this store over rediscovering resources from live Incus state.
 */
export class CapsuleBranchResourceStore {
  constructor(private readonly db: CapsuleHostDbContract) {}

  public async findBranchResourceByOperationKey(operationId: string, resourceKey: string) {
    return await this.db.query.capsuleBranchResources.findFirst({
      where: {
        createdByOperationId: operationId,
        resourceKey,
      },
    })
  }

  public async findBranchResourceByBranchKey(branchId: string, resourceKey: string) {
    return await this.db.query.capsuleBranchResources.findFirst({
      where: {
        branchId,
        resourceKey,
      },
    })
  }

  /**
   * Ensures a branch resource row exists without duplicating durable ownership records.
   *
   * This is idempotent for retry races and fail-closed accounting; it does not imply automatic replay of abandoned provisioning.
   */
  public async ensureBranchResource(input: BranchResourceInput): Promise<string> {
    const existingByOperation = await this.findBranchResourceByOperationKey(input.operationId, input.resourceKey)
    if (existingByOperation) {
      return existingByOperation.id
    }
    const existingByBranch = await this.findBranchResourceByBranchKey(input.branchId, input.resourceKey)
    if (existingByBranch) {
      return existingByBranch.id
    }
    try {
      return await this.createBranchResource(input)
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error
      }
      const racedByOperation = await this.findBranchResourceByOperationKey(input.operationId, input.resourceKey)
      if (racedByOperation) {
        return racedByOperation.id
      }
      const racedByBranch = await this.findBranchResourceByBranchKey(input.branchId, input.resourceKey)
      if (racedByBranch) {
        return racedByBranch.id
      }
      throw new IncusError('Capsule branch resource was created concurrently but could not be reloaded.', 'API_ERROR', {
        operationId: input.operationId,
        branchId: input.branchId,
        resourceKey: input.resourceKey,
      })
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
    await this.transitionBranchResourceStatusInternal(resourceId, status, metadata)
  }

  public async transitionBranchResourceStatusForOperation(
    resourceId: string,
    operationId: string,
    status: CapsuleBranchResourceStatusValue,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.transitionBranchResourceStatusInternal(resourceId, status, metadata, operationId)
  }

  public async markBranchResourceDeleting(resourceId: string): Promise<void> {
    await this.transitionBranchResourceStatus(resourceId, CapsuleBranchResourceStatus.DELETING)
  }

  public async markBranchResourceDeleted(resourceId: string): Promise<void> {
    await this.transitionBranchResourceStatus(resourceId, CapsuleBranchResourceStatus.DELETED)
  }

  public async markBranchResourceMissing(resourceId: string): Promise<void> {
    await this.transitionBranchResourceStatus(resourceId, CapsuleBranchResourceStatus.MISSING)
  }

  public async markBranchResourceError(resourceId: string, error: unknown, context?: Record<string, unknown>): Promise<void> {
    await this.markBranchResourceErrorInternal(resourceId, error, context)
  }

  public async markBranchResourceErrorForOperation(
    resourceId: string,
    operationId: string,
    error: unknown,
    context?: Record<string, unknown>,
  ): Promise<void> {
    await this.markBranchResourceErrorInternal(resourceId, error, context, operationId)
  }

  public async listBranchResources(ownerId: string, branchName: string) {
    return await this.db.query.capsuleBranchResources.findMany({
      where: {
        ownerId,
        branchName,
      },
      orderBy: (capsuleBranchResources, { asc }) => [asc(capsuleBranchResources.createdAt)],
    })
  }

  public async listBranchResourceInventory(ownerId: string, branchName: string) {
    return await this.listBranchResources(ownerId, branchName)
  }

  public async listCleanupCandidateResources(ownerId: string, branchName: string) {
    const resources = await this.listBranchResources(ownerId, branchName)
    const terminalStatuses: ReadonlySet<CapsuleBranchResourceStatusValue> = new Set([
      CapsuleBranchResourceStatus.DELETED,
      CapsuleBranchResourceStatus.MISSING,
    ])
    return resources.filter(resource => !terminalStatuses.has(resource.status))
  }

  public async listBranchResourceInventoryByBranchId(branchId: string) {
    return await this.db.query.capsuleBranchResources.findMany({
      where: {
        branchId,
      },
      orderBy: (capsuleBranchResources, { asc }) => [asc(capsuleBranchResources.createdAt)],
    })
  }

  public async listBranchResourcesByOperation(operationId: string) {
    return await this.db.query.capsuleBranchResources.findMany({
      where: {
        createdByOperationId: operationId,
      },
      orderBy: (capsuleBranchResources, { asc }) => [asc(capsuleBranchResources.createdAt)],
    })
  }

  public async updateLastOperation(resourceId: string, operationId: string): Promise<void> {
    await this.db
      .update(capsuleBranchResourcesTable)
      .set({
        lastOperationId: operationId,
        updatedAt: new Date(),
      })
      .where(eq(capsuleBranchResourcesTable.id, resourceId))
  }

  private async transitionBranchResourceStatusInternal(
    resourceId: string,
    status: CapsuleBranchResourceStatusValue,
    metadata?: Record<string, unknown>,
    operationId?: string,
  ): Promise<void> {
    const updateData: {
      status: CapsuleBranchResourceStatusValue
      metadata?: Record<string, unknown>
      lastOperationId?: string
      updatedAt: Date
    } = {
      status,
      updatedAt: new Date(),
    }
    if (metadata !== undefined) {
      updateData.metadata = toJsonObject(metadata, 'capsule branch resource metadata')
    }
    if (operationId !== undefined) {
      updateData.lastOperationId = operationId
    }
    await this.db.update(capsuleBranchResourcesTable).set(updateData).where(eq(capsuleBranchResourcesTable.id, resourceId))
  }

  private async markBranchResourceErrorInternal(
    resourceId: string,
    error: unknown,
    context?: Record<string, unknown>,
    operationId?: string,
  ): Promise<void> {
    const details = createFailureDetails(error, context)
    const updateData: {
      status: typeof CapsuleBranchResourceStatus.ERROR
      updatedAt: Date
      failureCode: string
      failureMessage: string
      failureDetails?: Record<string, unknown>
      lastOperationId?: string
    } = {
      status: CapsuleBranchResourceStatus.ERROR,
      updatedAt: new Date(),
      failureCode: failureCodeFromUnknown(error),
      failureMessage: failureMessageFromUnknown(error, 'Unknown capsule branch resource failure.'),
    }
    if (details !== undefined) {
      updateData.failureDetails = toJsonObject(details, 'capsule branch resource failure details')
    }
    if (operationId !== undefined) {
      updateData.lastOperationId = operationId
    }
    await this.db
      .update(capsuleBranchResourcesTable)
      .set(updateData)
      .where(and(eq(capsuleBranchResourcesTable.id, resourceId)))
  }
}
