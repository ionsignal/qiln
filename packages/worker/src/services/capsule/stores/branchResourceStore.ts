import { eq } from 'drizzle-orm'
import {
  capsuleBranchResourcesTable,
  type CapsuleBranchResourceStatus as CapsuleBranchResourceStatusValue,
  type CapsuleHostDbContract,
} from '@qiln/core/server'
import { IncusError } from '../../../errors'
import { detailsFromUnknown } from './errorDetails'
import { toJsonObject } from './jsonPersistence'
import type { BranchResourceInput } from './types'

/**
 * Persistence boundary for branch-owned resources.
 *
 * Resource rows are the durable inventory of external/provider resources touched by branch operations.
 * Later delete/recovery work should prefer this store over rediscovering resources from live Incus state.
 */
export class CapsuleBranchResourceStore {
  constructor(private readonly db: CapsuleHostDbContract) {}

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

  public async listBranchResources(ownerId: string, branchName: string) {
    return await this.db.query.capsuleBranchResources.findMany({
      where: {
        ownerId,
        branchName,
      },
      orderBy: (capsuleBranchResources, { asc }) => [asc(capsuleBranchResources.createdAt)],
    })
  }

  public async listBranchResourcesByBranchId(branchId: string) {
    return await this.db.query.capsuleBranchResources.findMany({
      where: {
        branchId,
      },
      orderBy: (capsuleBranchResources, { asc }) => [asc(capsuleBranchResources.createdAt)],
    })
  }
}
