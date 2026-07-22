import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  CapsuleBranchResourceCleanupPolicy,
  CapsuleBranchResourceStatus,
  CapsuleBranchResourceType,
  capsuleBranchResourcesTable,
  digestCanonicalJsonValue,
  type CapsuleHostDbContract,
} from '@qiln/core/server'
import { IncusError, isUniqueConstraintViolation } from '../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from '../failures'
import { toJsonObject } from '../persistence/json'
import type { BranchResourceInput, CapsuleBranchResourceInventoryRow } from './types'

const DEFAULT_RESOURCE_PROVIDER = 'incus'
const CREATE_INTENT_ELIGIBLE_RESOURCE_STATUSES = [CapsuleBranchResourceStatus.PLANNED] as const
const DIRECT_DELETE_INTENT_ELIGIBLE_RESOURCE_STATUSES = [CapsuleBranchResourceStatus.CREATED] as const
const DIRECT_DELETE_RESOURCE_TYPES = [
  CapsuleBranchResourceType.INCUS_INSTANCE,
  CapsuleBranchResourceType.ZFS_VOLUME,
] as const
const DIRECT_DELETE_OUTCOME_RESOURCE_STATUSES = [
  CapsuleBranchResourceStatus.DELETED,
  CapsuleBranchResourceStatus.MISSING,
] as const
const BOOTSTRAP_DERIVED_DELETE_ELIGIBLE_RESOURCE_STATUSES = [
  CapsuleBranchResourceStatus.PLANNED,
  CapsuleBranchResourceStatus.CREATING,
  CapsuleBranchResourceStatus.CREATED,
  CapsuleBranchResourceStatus.ERROR,
] as const

type DirectDeleteOutcomeResourceStatus = (typeof DIRECT_DELETE_OUTCOME_RESOURCE_STATUSES)[number]

function normalizedMetadata(
  metadata: Record<string, unknown> | null | undefined,
  context: string,
): Record<string, unknown> | null {
  return metadata === null || metadata === undefined ? null : toJsonObject(metadata, context)
}

function resourceIdentityDigest(provider: string, metadata: Record<string, unknown> | null, context: string): string {
  return digestCanonicalJsonValue(
    {
      provider,
      metadata,
    },
    {
      context,
    },
  )
}

/**
 * Persistence boundary for branch resource ownership and provider mutation
 * fences.
 *
 * Direct provider deletion is restricted to managed resources whose durable
 * state and cleanup policy prove Qiln created and owns them. Adopted, retained,
 * external, and derived resources cannot enter the direct provider deletion
 * path.
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

  public async ensureBranchResource(input: BranchResourceInput): Promise<string> {
    const existingByOperation = await this.findBranchResourceByOperationKey(input.operationId, input.resourceKey)
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
      const racedByOperation = await this.findBranchResourceByOperationKey(input.operationId, input.resourceKey)
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
        operationId: input.operationId,
        branchId: input.branchId,
        resourceKey: input.resourceKey,
      })
    }
  }

  public async createBranchResource(input: BranchResourceInput): Promise<string> {
    const provider = input.provider ?? DEFAULT_RESOURCE_PROVIDER
    const metadata = normalizedMetadata(input.metadata, 'capsule branch resource metadata')
    const [resource] = await this.db
      .insert(capsuleBranchResourcesTable)
      .values({
        createdByOperationId: input.operationId,
        lastOperationId: input.operationId,
        ownerId: input.ownerId,
        branchId: input.branchId,
        branchName: input.branchName,
        resourceType: input.resourceType,
        provider,
        resourceKey: input.resourceKey,
        cleanupPolicy: input.cleanupPolicy,
        status: CapsuleBranchResourceStatus.PLANNED,
        metadata,
        updatedAt: new Date(),
      })
      .returning({
        id: capsuleBranchResourcesTable.id,
      })

    if (!resource) {
      throw new IncusError('Failed to record capsule branch resource.', 'API_ERROR', {
        operationId: input.operationId,
        branchId: input.branchId,
        resourceKey: input.resourceKey,
      })
    }
    return resource.id
  }

  public async recordBranchResourceAdoption(resourceId: string, operationId: string): Promise<void> {
    const updatedResources = await this.db
      .update(capsuleBranchResourcesTable)
      .set({
        status: CapsuleBranchResourceStatus.ADOPTED,
        lastOperationId: operationId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(capsuleBranchResourcesTable.id, resourceId),
          eq(capsuleBranchResourcesTable.createdByOperationId, operationId),
          inArray(capsuleBranchResourcesTable.status, CREATE_INTENT_ELIGIBLE_RESOURCE_STATUSES),
        ),
      )
      .returning({
        id: capsuleBranchResourcesTable.id,
      })
    if (updatedResources.length !== 1) {
      throw new IncusError(
        'Failed to persist capsule branch resource adoption. Manual review is required.',
        'CONFLICT',
        {
          resourceId,
          operationId,
        },
      )
    }
  }

  public async recordBranchResourceCreateIntent(resourceId: string, operationId: string): Promise<void> {
    const updatedResources = await this.db
      .update(capsuleBranchResourcesTable)
      .set({
        status: CapsuleBranchResourceStatus.CREATING,
        lastOperationId: operationId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(capsuleBranchResourcesTable.id, resourceId),
          eq(capsuleBranchResourcesTable.createdByOperationId, operationId),
          inArray(capsuleBranchResourcesTable.status, CREATE_INTENT_ELIGIBLE_RESOURCE_STATUSES),
        ),
      )
      .returning({
        id: capsuleBranchResourcesTable.id,
      })
    if (updatedResources.length !== 1) {
      throw new IncusError(
        'Failed to persist capsule branch resource create intent. Manual review is required.',
        'CONFLICT',
        {
          resourceId,
          operationId,
        },
      )
    }
  }

  public async recordBranchResourceCreateOutcome(resourceId: string, operationId: string): Promise<void> {
    const updatedResources = await this.db
      .update(capsuleBranchResourcesTable)
      .set({
        status: CapsuleBranchResourceStatus.CREATED,
        lastOperationId: operationId,
        updatedAt: new Date(),
        failureCode: null,
        failureMessage: null,
        failureDetails: null,
      })
      .where(
        and(
          eq(capsuleBranchResourcesTable.id, resourceId),
          eq(capsuleBranchResourcesTable.createdByOperationId, operationId),
          eq(capsuleBranchResourcesTable.status, CapsuleBranchResourceStatus.CREATING),
          eq(capsuleBranchResourcesTable.lastOperationId, operationId),
        ),
      )
      .returning({
        id: capsuleBranchResourcesTable.id,
      })
    if (updatedResources.length !== 1) {
      throw new IncusError(
        'Failed to persist capsule branch resource create outcome. Manual review is required.',
        'CONFLICT',
        {
          resourceId,
          operationId,
        },
      )
    }
  }

  public async recordBranchResourceCreateFailure(
    resourceId: string,
    operationId: string,
    error: unknown,
    context?: Record<string, unknown>,
  ): Promise<void> {
    const details = createFailureDetails(error, context)
    const updatedResources = await this.db
      .update(capsuleBranchResourcesTable)
      .set({
        status: CapsuleBranchResourceStatus.ERROR,
        lastOperationId: operationId,
        updatedAt: new Date(),
        failureCode: failureCodeFromUnknown(error),
        failureMessage: failureMessageFromUnknown(error, 'Unknown capsule branch resource create failure.'),
        failureDetails:
          details === undefined ? undefined : toJsonObject(details, 'capsule branch resource create failure details'),
      })
      .where(
        and(
          eq(capsuleBranchResourcesTable.id, resourceId),
          eq(capsuleBranchResourcesTable.createdByOperationId, operationId),
          eq(capsuleBranchResourcesTable.status, CapsuleBranchResourceStatus.CREATING),
          eq(capsuleBranchResourcesTable.lastOperationId, operationId),
        ),
      )
      .returning({
        id: capsuleBranchResourcesTable.id,
      })
    if (updatedResources.length !== 1) {
      throw new IncusError(
        'Failed to persist capsule branch resource create failure. Manual review is required.',
        'CONFLICT',
        {
          resourceId,
          operationId,
        },
      )
    }
  }

  public async recordBranchResourceDeleteIntent(resourceId: string, operationId: string): Promise<void> {
    const updatedResources = await this.db
      .update(capsuleBranchResourcesTable)
      .set({
        status: CapsuleBranchResourceStatus.DELETING,
        lastOperationId: operationId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(capsuleBranchResourcesTable.id, resourceId),
          inArray(capsuleBranchResourcesTable.status, DIRECT_DELETE_INTENT_ELIGIBLE_RESOURCE_STATUSES),
          eq(capsuleBranchResourcesTable.cleanupPolicy, CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH),
          inArray(capsuleBranchResourcesTable.resourceType, DIRECT_DELETE_RESOURCE_TYPES),
        ),
      )
      .returning({
        id: capsuleBranchResourcesTable.id,
      })
    if (updatedResources.length !== 1) {
      throw new IncusError(
        'Failed to persist capsule branch resource delete intent. Manual review is required.',
        'CONFLICT',
        {
          resourceId,
          operationId,
        },
      )
    }
  }

  public async recordBranchResourceDeleteOutcome(
    resourceId: string,
    operationId: string,
    outcome: DirectDeleteOutcomeResourceStatus,
  ): Promise<void> {
    const updatedResources = await this.db
      .update(capsuleBranchResourcesTable)
      .set({
        status: outcome,
        lastOperationId: operationId,
        updatedAt: new Date(),
        failureCode: null,
        failureMessage: null,
        failureDetails: null,
      })
      .where(
        and(
          eq(capsuleBranchResourcesTable.id, resourceId),
          eq(capsuleBranchResourcesTable.status, CapsuleBranchResourceStatus.DELETING),
          eq(capsuleBranchResourcesTable.lastOperationId, operationId),
          eq(capsuleBranchResourcesTable.cleanupPolicy, CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH),
          inArray(capsuleBranchResourcesTable.resourceType, DIRECT_DELETE_RESOURCE_TYPES),
        ),
      )
      .returning({
        id: capsuleBranchResourcesTable.id,
      })
    if (updatedResources.length !== 1) {
      throw new IncusError(
        'Failed to persist capsule branch resource delete outcome. Manual review is required.',
        'CONFLICT',
        {
          resourceId,
          operationId,
          outcome,
        },
      )
    }
  }

  public async recordBranchResourceDeleteFailure(
    resourceId: string,
    operationId: string,
    error: unknown,
    context?: Record<string, unknown>,
  ): Promise<void> {
    const details = createFailureDetails(error, context)
    const updatedResources = await this.db
      .update(capsuleBranchResourcesTable)
      .set({
        status: CapsuleBranchResourceStatus.ERROR,
        lastOperationId: operationId,
        updatedAt: new Date(),
        failureCode: failureCodeFromUnknown(error),
        failureMessage: failureMessageFromUnknown(error, 'Unknown capsule branch resource delete failure.'),
        failureDetails:
          details === undefined ? undefined : toJsonObject(details, 'capsule branch resource delete failure details'),
      })
      .where(
        and(
          eq(capsuleBranchResourcesTable.id, resourceId),
          eq(capsuleBranchResourcesTable.status, CapsuleBranchResourceStatus.DELETING),
          eq(capsuleBranchResourcesTable.lastOperationId, operationId),
          eq(capsuleBranchResourcesTable.cleanupPolicy, CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH),
          inArray(capsuleBranchResourcesTable.resourceType, DIRECT_DELETE_RESOURCE_TYPES),
        ),
      )
      .returning({
        id: capsuleBranchResourcesTable.id,
      })
    if (updatedResources.length !== 1) {
      throw new IncusError(
        'Failed to persist capsule branch resource delete failure. Manual review is required.',
        'CONFLICT',
        {
          resourceId,
          operationId,
        },
      )
    }
  }

  /**
   * Destroy-specific derived finalization.
   *
   * The destroy executor must first prove the provisioning file's backing
   * resource reached a terminal direct-resource outcome.
   */
  public async recordDestroyDerivedResourceDeletion(resourceId: string, operationId: string): Promise<void> {
    const updatedResources = await this.db
      .update(capsuleBranchResourcesTable)
      .set({
        status: CapsuleBranchResourceStatus.DELETED,
        lastOperationId: operationId,
        updatedAt: new Date(),
        failureCode: null,
        failureMessage: null,
        failureDetails: null,
      })
      .where(
        and(
          eq(capsuleBranchResourcesTable.id, resourceId),
          eq(capsuleBranchResourcesTable.resourceType, CapsuleBranchResourceType.PROVISIONING_FILE),
          eq(capsuleBranchResourcesTable.cleanupPolicy, CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH),
          eq(capsuleBranchResourcesTable.status, CapsuleBranchResourceStatus.CREATED),
        ),
      )
      .returning({
        id: capsuleBranchResourcesTable.id,
      })
    if (updatedResources.length !== 1) {
      throw new IncusError('Failed to finalize destroy-time provisioning-file resource outcome.', 'CONFLICT', {
        resourceId,
        operationId,
      })
    }
  }

  /**
   * Create-only derived cleanup after the backing resource has been proven
   * compensated.
   *
   * The broader eligible statuses reflect partial provisioning-file creation,
   * not authorization to delete a direct provider resource.
   */
  public async recordCreateCompensatedDerivedResourceDeletion(resourceId: string, operationId: string): Promise<void> {
    const updatedResources = await this.db
      .update(capsuleBranchResourcesTable)
      .set({
        status: CapsuleBranchResourceStatus.DELETED,
        lastOperationId: operationId,
        updatedAt: new Date(),
        failureCode: null,
        failureMessage: null,
        failureDetails: null,
      })
      .where(
        and(
          eq(capsuleBranchResourcesTable.id, resourceId),
          eq(capsuleBranchResourcesTable.resourceType, CapsuleBranchResourceType.PROVISIONING_FILE),
          eq(capsuleBranchResourcesTable.cleanupPolicy, CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH),
          inArray(capsuleBranchResourcesTable.status, BOOTSTRAP_DERIVED_DELETE_ELIGIBLE_RESOURCE_STATUSES),
        ),
      )
      .returning({
        id: capsuleBranchResourcesTable.id,
      })
    if (updatedResources.length !== 1) {
      throw new IncusError('Failed to persist compensated create provisioning-file cleanup.', 'CONFLICT', {
        resourceId,
        operationId,
      })
    }
  }

  public async markBranchResourceError(
    resourceId: string,
    error: unknown,
    context?: Record<string, unknown>,
  ): Promise<void> {
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
    const updated = await this.db
      .update(capsuleBranchResourcesTable)
      .set(updateData)
      .where(eq(capsuleBranchResourcesTable.id, resourceId))
      .returning({
        id: capsuleBranchResourcesTable.id,
      })
    if (updated.length !== 1) {
      throw new IncusError('Capsule branch resource was not found while recording its failure.', 'NOT_FOUND', {
        resourceId,
      })
    }
  }

  public async listBranchResources(ownerId: string, branchName: string) {
    return await this.db.query.capsuleBranchResources.findMany({
      where: {
        ownerId,
        branchName,
      },
      orderBy: (resources, { asc }) => [asc(resources.createdAt), asc(resources.id)],
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
        createdByOperationId: capsuleBranchResourcesTable.createdByOperationId,
        lastOperationId: capsuleBranchResourcesTable.lastOperationId,
      })
      .from(capsuleBranchResourcesTable)
      .where(eq(capsuleBranchResourcesTable.branchId, branchId))
      .orderBy(asc(capsuleBranchResourcesTable.createdAt), asc(capsuleBranchResourcesTable.id))
  }

  public async listBranchResourceInventories(
    branchIds: readonly string[],
  ): Promise<CapsuleBranchResourceInventoryRow[]> {
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
        createdByOperationId: capsuleBranchResourcesTable.createdByOperationId,
        lastOperationId: capsuleBranchResourcesTable.lastOperationId,
      })
      .from(capsuleBranchResourcesTable)
      .where(inArray(capsuleBranchResourcesTable.branchId, [...branchIds]))
      .orderBy(
        asc(capsuleBranchResourcesTable.branchId),
        asc(capsuleBranchResourcesTable.createdAt),
        asc(capsuleBranchResourcesTable.id),
      )
  }

  private assertExistingResourceIdentity(
    existing: {
      ownerId: string
      branchId: string | null
      branchName: string
      provider: string
      resourceType: BranchResourceInput['resourceType']
      cleanupPolicy: BranchResourceInput['cleanupPolicy']
      resourceKey: string
      metadata: Record<string, unknown> | null
    },
    input: BranchResourceInput,
  ): void {
    const expectedProvider = input.provider ?? DEFAULT_RESOURCE_PROVIDER
    const expectedMetadata = normalizedMetadata(input.metadata, 'requested capsule branch resource metadata')
    const existingIdentityDigest = resourceIdentityDigest(
      existing.provider,
      existing.metadata,
      'existing capsule branch resource identity',
    )
    const expectedIdentityDigest = resourceIdentityDigest(
      expectedProvider,
      expectedMetadata,
      'requested capsule branch resource identity',
    )
    if (
      existing.ownerId !== input.ownerId ||
      existing.branchId !== input.branchId ||
      existing.branchName !== input.branchName ||
      existing.provider !== expectedProvider ||
      existing.resourceType !== input.resourceType ||
      existing.cleanupPolicy !== input.cleanupPolicy ||
      existing.resourceKey !== input.resourceKey ||
      existingIdentityDigest !== expectedIdentityDigest
    ) {
      throw new IncusError(
        'Existing capsule branch resource identity does not match the requested durable inventory entry.',
        'CONFLICT',
        {
          operationId: input.operationId,
          branchId: input.branchId,
          resourceKey: input.resourceKey,
        },
      )
    }
  }
}
