import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  CapsuleBranchResourceStatus,
  CapsuleBranchResourceType,
  capsuleBranchResourcesTable,
  type CapsuleHostDbContract,
} from '@qiln/core/server'
import { IncusError, isUniqueConstraintViolation } from '../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from './errorDetails'
import { toJsonObject } from './jsonPersistence'
import type { BranchResourceInput, CapsuleBranchResourceInventoryRow } from './types'

const CREATE_INTENT_ELIGIBLE_RESOURCE_STATUSES = [CapsuleBranchResourceStatus.PLANNED] as const
const DIRECT_DELETE_INTENT_ELIGIBLE_RESOURCE_STATUSES = [CapsuleBranchResourceStatus.CREATED] as const
const DIRECT_DELETE_OUTCOME_RESOURCE_STATUSES = [CapsuleBranchResourceStatus.DELETED, CapsuleBranchResourceStatus.MISSING] as const
const BOOTSTRAP_DERIVED_DELETE_ELIGIBLE_RESOURCE_STATUSES = [
  CapsuleBranchResourceStatus.PLANNED,
  CapsuleBranchResourceStatus.CREATING,
  CapsuleBranchResourceStatus.CREATED,
  CapsuleBranchResourceStatus.ERROR,
] as const

type DirectDeleteOutcomeResourceStatus = (typeof DIRECT_DELETE_OUTCOME_RESOURCE_STATUSES)[number]

/**
 * Persistence boundary for branch resource ownership and provider mutation fences.
 *
 * Direct provider deletion is restricted to resources whose durable state proves Qiln created them.
 * Adopted and external resources cannot enter the direct deletion path.
 */
export class CapsuleBranchResourceStore {
  constructor(private readonly db: CapsuleHostDbContract) {}

  public async findBranchResourceByLifecycleOperationKey(lifecycleOperationId: string, resourceKey: string) {
    return await this.db.query.capsuleBranchResources.findFirst({
      where: {
        createdByLifecycleOperationId: lifecycleOperationId,
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

  public async ensureBranchResource(input: BranchResourceInput): Promise<string> {
    const existingByOperation = await this.findBranchResourceByLifecycleOperationKey(input.lifecycleOperationId, input.resourceKey)
    if (existingByOperation) {
      this.assertExistingResourceIdentity(existingByOperation, input)
      return existingByOperation.id
    }
    const existingByBranch = await this.findBranchResourceByBranchKey(input.branchId, input.resourceKey)
    if (existingByBranch) {
      this.assertExistingResourceIdentity(existingByBranch, input)
      return existingByBranch.id
    }
    try {
      return await this.createBranchResource(input)
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error
      }
      const racedByOperation = await this.findBranchResourceByLifecycleOperationKey(input.lifecycleOperationId, input.resourceKey)
      if (racedByOperation) {
        this.assertExistingResourceIdentity(racedByOperation, input)
        return racedByOperation.id
      }
      const racedByBranch = await this.findBranchResourceByBranchKey(input.branchId, input.resourceKey)
      if (racedByBranch) {
        this.assertExistingResourceIdentity(racedByBranch, input)
        return racedByBranch.id
      }
      throw new IncusError('Capsule branch resource was created concurrently but could not be reloaded.', 'API_ERROR', {
        lifecycleOperationId: input.lifecycleOperationId,
        branchId: input.branchId,
        resourceKey: input.resourceKey,
      })
    }
  }

  public async createBranchResource(input: BranchResourceInput): Promise<string> {
    const [resource] = await this.db
      .insert(capsuleBranchResourcesTable)
      .values({
        createdByLifecycleOperationId: input.lifecycleOperationId,
        lastLifecycleOperationId: input.lifecycleOperationId,
        ownerId: input.ownerId,
        branchId: input.branchId,
        branchName: input.branchName,
        resourceType: input.resourceType,
        resourceKey: input.resourceKey,
        cleanupPolicy: input.cleanupPolicy,
        status: CapsuleBranchResourceStatus.PLANNED,
        metadata: input.metadata === undefined ? undefined : toJsonObject(input.metadata, 'capsule branch resource metadata'),
        updatedAt: new Date(),
      })
      .returning({
        id: capsuleBranchResourcesTable.id,
      })

    if (!resource) {
      throw new IncusError('Failed to record capsule branch resource.', 'API_ERROR', {
        lifecycleOperationId: input.lifecycleOperationId,
        branchId: input.branchId,
        resourceKey: input.resourceKey,
      })
    }
    return resource.id
  }

  public async recordBranchResourceAdoption(resourceId: string, lifecycleOperationId: string): Promise<void> {
    const updatedResources = await this.db
      .update(capsuleBranchResourcesTable)
      .set({
        status: CapsuleBranchResourceStatus.ADOPTED,
        lastLifecycleOperationId: lifecycleOperationId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(capsuleBranchResourcesTable.id, resourceId),
          eq(capsuleBranchResourcesTable.createdByLifecycleOperationId, lifecycleOperationId),
          inArray(capsuleBranchResourcesTable.status, CREATE_INTENT_ELIGIBLE_RESOURCE_STATUSES),
        ),
      )
      .returning({
        id: capsuleBranchResourcesTable.id,
      })
    if (updatedResources.length !== 1) {
      throw new IncusError('Failed to persist capsule branch resource adoption. Manual review is required.', 'CONFLICT', {
        resourceId,
        lifecycleOperationId,
      })
    }
  }

  public async recordBranchResourceCreateIntent(resourceId: string, lifecycleOperationId: string): Promise<void> {
    const updatedResources = await this.db
      .update(capsuleBranchResourcesTable)
      .set({
        status: CapsuleBranchResourceStatus.CREATING,
        lastLifecycleOperationId: lifecycleOperationId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(capsuleBranchResourcesTable.id, resourceId),
          eq(capsuleBranchResourcesTable.createdByLifecycleOperationId, lifecycleOperationId),
          inArray(capsuleBranchResourcesTable.status, CREATE_INTENT_ELIGIBLE_RESOURCE_STATUSES),
        ),
      )
      .returning({
        id: capsuleBranchResourcesTable.id,
      })
    if (updatedResources.length !== 1) {
      throw new IncusError('Failed to persist capsule branch resource create intent. Manual review is required.', 'CONFLICT', {
        resourceId,
        lifecycleOperationId,
      })
    }
  }

  public async recordBranchResourceCreateOutcome(resourceId: string, lifecycleOperationId: string): Promise<void> {
    const updatedResources = await this.db
      .update(capsuleBranchResourcesTable)
      .set({
        status: CapsuleBranchResourceStatus.CREATED,
        lastLifecycleOperationId: lifecycleOperationId,
        updatedAt: new Date(),
        failureCode: null,
        failureMessage: null,
        failureDetails: null,
      })
      .where(
        and(
          eq(capsuleBranchResourcesTable.id, resourceId),
          eq(capsuleBranchResourcesTable.createdByLifecycleOperationId, lifecycleOperationId),
          eq(capsuleBranchResourcesTable.status, CapsuleBranchResourceStatus.CREATING),
          eq(capsuleBranchResourcesTable.lastLifecycleOperationId, lifecycleOperationId),
        ),
      )
      .returning({
        id: capsuleBranchResourcesTable.id,
      })
    if (updatedResources.length !== 1) {
      throw new IncusError('Failed to persist capsule branch resource create outcome. Manual review is required.', 'CONFLICT', {
        resourceId,
        lifecycleOperationId,
      })
    }
  }

  public async recordBranchResourceCreateFailure(
    resourceId: string,
    lifecycleOperationId: string,
    error: unknown,
    context?: Record<string, unknown>,
  ): Promise<void> {
    const details = createFailureDetails(error, context)
    const updatedResources = await this.db
      .update(capsuleBranchResourcesTable)
      .set({
        status: CapsuleBranchResourceStatus.ERROR,
        lastLifecycleOperationId: lifecycleOperationId,
        updatedAt: new Date(),
        failureCode: failureCodeFromUnknown(error),
        failureMessage: failureMessageFromUnknown(error, 'Unknown capsule branch resource create failure.'),
        failureDetails: details === undefined ? undefined : toJsonObject(details, 'capsule branch resource create failure details'),
      })
      .where(
        and(
          eq(capsuleBranchResourcesTable.id, resourceId),
          eq(capsuleBranchResourcesTable.createdByLifecycleOperationId, lifecycleOperationId),
          eq(capsuleBranchResourcesTable.status, CapsuleBranchResourceStatus.CREATING),
          eq(capsuleBranchResourcesTable.lastLifecycleOperationId, lifecycleOperationId),
        ),
      )
      .returning({
        id: capsuleBranchResourcesTable.id,
      })
    if (updatedResources.length !== 1) {
      throw new IncusError('Failed to persist capsule branch resource create failure. Manual review is required.', 'CONFLICT', {
        resourceId,
        lifecycleOperationId,
      })
    }
  }

  public async recordBranchResourceDeleteIntent(resourceId: string, lifecycleOperationId: string): Promise<void> {
    const updatedResources = await this.db
      .update(capsuleBranchResourcesTable)
      .set({
        status: CapsuleBranchResourceStatus.DELETING,
        lastLifecycleOperationId: lifecycleOperationId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(capsuleBranchResourcesTable.id, resourceId),
          inArray(capsuleBranchResourcesTable.status, DIRECT_DELETE_INTENT_ELIGIBLE_RESOURCE_STATUSES),
        ),
      )
      .returning({
        id: capsuleBranchResourcesTable.id,
      })
    if (updatedResources.length !== 1) {
      throw new IncusError('Failed to persist capsule branch resource delete intent. Manual review is required.', 'CONFLICT', {
        resourceId,
        lifecycleOperationId,
      })
    }
  }

  public async recordBranchResourceDeleteOutcome(
    resourceId: string,
    lifecycleOperationId: string,
    outcome: DirectDeleteOutcomeResourceStatus,
  ): Promise<void> {
    const updatedResources = await this.db
      .update(capsuleBranchResourcesTable)
      .set({
        status: outcome,
        lastLifecycleOperationId: lifecycleOperationId,
        updatedAt: new Date(),
        failureCode: null,
        failureMessage: null,
        failureDetails: null,
      })
      .where(
        and(
          eq(capsuleBranchResourcesTable.id, resourceId),
          eq(capsuleBranchResourcesTable.status, CapsuleBranchResourceStatus.DELETING),
          eq(capsuleBranchResourcesTable.lastLifecycleOperationId, lifecycleOperationId),
        ),
      )
      .returning({
        id: capsuleBranchResourcesTable.id,
      })
    if (updatedResources.length !== 1) {
      throw new IncusError('Failed to persist capsule branch resource delete outcome. Manual review is required.', 'CONFLICT', {
        resourceId,
        lifecycleOperationId,
        outcome,
      })
    }
  }

  public async recordBranchResourceDeleteFailure(
    resourceId: string,
    lifecycleOperationId: string,
    error: unknown,
    context?: Record<string, unknown>,
  ): Promise<void> {
    const details = createFailureDetails(error, context)
    const updatedResources = await this.db
      .update(capsuleBranchResourcesTable)
      .set({
        status: CapsuleBranchResourceStatus.ERROR,
        lastLifecycleOperationId: lifecycleOperationId,
        updatedAt: new Date(),
        failureCode: failureCodeFromUnknown(error),
        failureMessage: failureMessageFromUnknown(error, 'Unknown capsule branch resource delete failure.'),
        failureDetails: details === undefined ? undefined : toJsonObject(details, 'capsule branch resource delete failure details'),
      })
      .where(
        and(
          eq(capsuleBranchResourcesTable.id, resourceId),
          eq(capsuleBranchResourcesTable.status, CapsuleBranchResourceStatus.DELETING),
          eq(capsuleBranchResourcesTable.lastLifecycleOperationId, lifecycleOperationId),
        ),
      )
      .returning({
        id: capsuleBranchResourcesTable.id,
      })
    if (updatedResources.length !== 1) {
      throw new IncusError('Failed to persist capsule branch resource delete failure. Manual review is required.', 'CONFLICT', {
        resourceId,
        lifecycleOperationId,
      })
    }
  }

  /**
   * Destroy-specific derived finalization. A provisioning-file resource must have a proven created
   * state before destroy can mark it deleted.
   */
  public async recordDestroyDerivedResourceDeletion(resourceId: string, lifecycleOperationId: string): Promise<void> {
    const updatedResources = await this.db
      .update(capsuleBranchResourcesTable)
      .set({
        status: CapsuleBranchResourceStatus.DELETED,
        lastLifecycleOperationId: lifecycleOperationId,
        updatedAt: new Date(),
        failureCode: null,
        failureMessage: null,
        failureDetails: null,
      })
      .where(
        and(
          eq(capsuleBranchResourcesTable.id, resourceId),
          eq(capsuleBranchResourcesTable.resourceType, CapsuleBranchResourceType.PROVISIONING_FILE),
          eq(capsuleBranchResourcesTable.status, CapsuleBranchResourceStatus.CREATED),
        ),
      )
      .returning({
        id: capsuleBranchResourcesTable.id,
      })
    if (updatedResources.length !== 1) {
      throw new IncusError('Failed to finalize destroy-time provisioning-file resource outcome.', 'CONFLICT', {
        resourceId,
        lifecycleOperationId,
      })
    }
  }

  /**
   * Bootstrap-only derived cleanup after the backing resource has been proven compensated.
   * Broader eligible states reflect partial bootstrap creation.
   */
  public async recordBootstrapCompensatedDerivedResourceDeletion(resourceId: string, lifecycleOperationId: string): Promise<void> {
    const updatedResources = await this.db
      .update(capsuleBranchResourcesTable)
      .set({
        status: CapsuleBranchResourceStatus.DELETED,
        lastLifecycleOperationId: lifecycleOperationId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(capsuleBranchResourcesTable.id, resourceId),
          eq(capsuleBranchResourcesTable.resourceType, CapsuleBranchResourceType.PROVISIONING_FILE),
          inArray(capsuleBranchResourcesTable.status, BOOTSTRAP_DERIVED_DELETE_ELIGIBLE_RESOURCE_STATUSES),
        ),
      )
      .returning({
        id: capsuleBranchResourcesTable.id,
      })
    if (updatedResources.length !== 1) {
      throw new IncusError('Failed to persist compensated bootstrap provisioning-file cleanup.', 'CONFLICT', {
        resourceId,
        lifecycleOperationId,
      })
    }
  }

  public async markBranchResourceError(resourceId: string, error: unknown, context?: Record<string, unknown>): Promise<void> {
    const details = createFailureDetails(error, context)
    const updateData: {
      status: typeof CapsuleBranchResourceStatus.ERROR
      updatedAt: Date
      failureCode: string
      failureMessage: string
      failureDetails?: Record<string, unknown>
    } = {
      status: CapsuleBranchResourceStatus.ERROR,
      updatedAt: new Date(),
      failureCode: failureCodeFromUnknown(error),
      failureMessage: failureMessageFromUnknown(error, 'Unknown capsule branch resource failure.'),
    }
    if (details !== undefined) {
      updateData.failureDetails = toJsonObject(details, 'capsule branch resource failure details')
    }
    await this.db.update(capsuleBranchResourcesTable).set(updateData).where(eq(capsuleBranchResourcesTable.id, resourceId))
  }

  public async listBranchResources(ownerId: string, branchName: string) {
    return await this.db.query.capsuleBranchResources.findMany({
      where: {
        ownerId,
        branchName,
      },
      orderBy: (resources, { asc }) => [asc(resources.createdAt)],
    })
  }

  public async listBranchResourceInventoryByBranchId(branchId: string): Promise<CapsuleBranchResourceInventoryRow[]> {
    return await this.db
      .select({
        id: capsuleBranchResourcesTable.id,
        ownerId: capsuleBranchResourcesTable.ownerId,
        branchId: capsuleBranchResourcesTable.branchId,
        branchName: capsuleBranchResourcesTable.branchName,
        provider: capsuleBranchResourcesTable.provider,
        resourceType: capsuleBranchResourcesTable.resourceType,
        resourceKey: capsuleBranchResourcesTable.resourceKey,
        status: capsuleBranchResourcesTable.status,
        cleanupPolicy: capsuleBranchResourcesTable.cleanupPolicy,
        metadata: capsuleBranchResourcesTable.metadata,
        createdByLifecycleOperationId: capsuleBranchResourcesTable.createdByLifecycleOperationId,
        lastLifecycleOperationId: capsuleBranchResourcesTable.lastLifecycleOperationId,
      })
      .from(capsuleBranchResourcesTable)
      .where(eq(capsuleBranchResourcesTable.branchId, branchId))
      .orderBy(asc(capsuleBranchResourcesTable.createdAt), asc(capsuleBranchResourcesTable.id))
  }

  public async listBranchResourceInventories(branchIds: readonly string[]): Promise<CapsuleBranchResourceInventoryRow[]> {
    if (branchIds.length === 0) {
      return []
    }
    return await this.db
      .select({
        id: capsuleBranchResourcesTable.id,
        ownerId: capsuleBranchResourcesTable.ownerId,
        branchId: capsuleBranchResourcesTable.branchId,
        branchName: capsuleBranchResourcesTable.branchName,
        provider: capsuleBranchResourcesTable.provider,
        resourceType: capsuleBranchResourcesTable.resourceType,
        resourceKey: capsuleBranchResourcesTable.resourceKey,
        status: capsuleBranchResourcesTable.status,
        cleanupPolicy: capsuleBranchResourcesTable.cleanupPolicy,
        metadata: capsuleBranchResourcesTable.metadata,
        createdByLifecycleOperationId: capsuleBranchResourcesTable.createdByLifecycleOperationId,
        lastLifecycleOperationId: capsuleBranchResourcesTable.lastLifecycleOperationId,
      })
      .from(capsuleBranchResourcesTable)
      .where(inArray(capsuleBranchResourcesTable.branchId, [...branchIds]))
      .orderBy(asc(capsuleBranchResourcesTable.branchId), asc(capsuleBranchResourcesTable.createdAt), asc(capsuleBranchResourcesTable.id))
  }

  private assertExistingResourceIdentity(
    existing: {
      ownerId: string
      branchId: string | null
      branchName: string
      resourceType: BranchResourceInput['resourceType']
      cleanupPolicy: BranchResourceInput['cleanupPolicy']
    },
    input: BranchResourceInput,
  ): void {
    if (
      existing.ownerId !== input.ownerId ||
      existing.branchId !== input.branchId ||
      existing.branchName !== input.branchName ||
      existing.resourceType !== input.resourceType ||
      existing.cleanupPolicy !== input.cleanupPolicy
    ) {
      throw new IncusError('Existing capsule branch resource identity does not match the requested durable inventory entry.', 'CONFLICT', {
        lifecycleOperationId: input.lifecycleOperationId,
        branchId: input.branchId,
        resourceKey: input.resourceKey,
      })
    }
  }
}
