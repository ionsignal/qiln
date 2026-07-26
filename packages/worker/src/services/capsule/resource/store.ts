import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  CapsuleBranchResourceCleanupPolicy,
  CapsuleBranchResourceStatus,
  CapsuleBranchResourceType,
  digestCanonicalJsonValue,
  type QilnPersistence,
  type QilnTables,
} from '@qiln/core/server'
import { IncusError, isUniqueConstraintViolation } from '../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from '../failures'
import { toJsonObject } from '../persistence/json'
import type { BranchResourceInput, CapsuleBranchResourceInventoryRow } from './types'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

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

function resourceIdentityDigest(
  provider: string,
  blueprintVolumeName: BranchResourceInput['blueprintVolumeName'],
  metadata: Record<string, unknown> | null,
  context: string,
): string {
  return digestCanonicalJsonValue(
    {
      provider,
      blueprintVolumeName,
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
export class CapsuleBranchResourceStore<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends QilnTables = QilnTables,
> {
  constructor(private readonly persistence: QilnPersistence<TDatabase, TTables>) {}

  public async findBranchResourceByOperationKey(operationId: string, resourceKey: string) {
    const db = this.persistence.db
    const resources = this.persistence.tables.capsuleBranchResources
    const [resource] = await db
      .select()
      .from(resources)
      .where(and(eq(resources.createdByOperationId, operationId), eq(resources.resourceKey, resourceKey)))
      .limit(1)
    return resource ?? null
  }

  public async findBranchResourceByBranchKey(branchId: string, resourceKey: string) {
    const db = this.persistence.db
    const resources = this.persistence.tables.capsuleBranchResources
    const [resource] = await db
      .select()
      .from(resources)
      .where(and(eq(resources.branchId, branchId), eq(resources.resourceKey, resourceKey)))
      .limit(1)
    return resource ?? null
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
    const db = this.persistence.db
    const resources = this.persistence.tables.capsuleBranchResources
    const provider = input.provider ?? DEFAULT_RESOURCE_PROVIDER
    const metadata = normalizedMetadata(input.metadata, 'capsule branch resource metadata')
    const [resource] = await db
      .insert(resources)
      .values({
        createdByOperationId: input.operationId,
        lastOperationId: input.operationId,
        ownerId: input.ownerId,
        branchId: input.branchId,
        branchName: input.branchName,
        resourceType: input.resourceType,
        provider,
        resourceKey: input.resourceKey,
        blueprintVolumeName: input.blueprintVolumeName,
        cleanupPolicy: input.cleanupPolicy,
        status: CapsuleBranchResourceStatus.PLANNED,
        metadata,
        updatedAt: new Date(),
      })
      .returning({
        id: resources.id,
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
    const db = this.persistence.db
    const resources = this.persistence.tables.capsuleBranchResources
    const updatedResources = await db
      .update(resources)
      .set({
        status: CapsuleBranchResourceStatus.ADOPTED,
        lastOperationId: operationId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(resources.id, resourceId),
          eq(resources.createdByOperationId, operationId),
          inArray(resources.status, CREATE_INTENT_ELIGIBLE_RESOURCE_STATUSES),
        ),
      )
      .returning({
        id: resources.id,
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
    const db = this.persistence.db
    const resources = this.persistence.tables.capsuleBranchResources
    const updatedResources = await db
      .update(resources)
      .set({
        status: CapsuleBranchResourceStatus.CREATING,
        lastOperationId: operationId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(resources.id, resourceId),
          eq(resources.createdByOperationId, operationId),
          inArray(resources.status, CREATE_INTENT_ELIGIBLE_RESOURCE_STATUSES),
        ),
      )
      .returning({
        id: resources.id,
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
    const db = this.persistence.db
    const resources = this.persistence.tables.capsuleBranchResources
    const updatedResources = await db
      .update(resources)
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
          eq(resources.id, resourceId),
          eq(resources.createdByOperationId, operationId),
          eq(resources.status, CapsuleBranchResourceStatus.CREATING),
          eq(resources.lastOperationId, operationId),
        ),
      )
      .returning({
        id: resources.id,
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
    const db = this.persistence.db
    const resources = this.persistence.tables.capsuleBranchResources
    const details = createFailureDetails(error, context)
    const updatedResources = await db
      .update(resources)
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
          eq(resources.id, resourceId),
          eq(resources.createdByOperationId, operationId),
          eq(resources.status, CapsuleBranchResourceStatus.CREATING),
          eq(resources.lastOperationId, operationId),
        ),
      )
      .returning({
        id: resources.id,
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
    const db = this.persistence.db
    const resources = this.persistence.tables.capsuleBranchResources
    const updatedResources = await db
      .update(resources)
      .set({
        status: CapsuleBranchResourceStatus.DELETING,
        lastOperationId: operationId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(resources.id, resourceId),
          inArray(resources.status, DIRECT_DELETE_INTENT_ELIGIBLE_RESOURCE_STATUSES),
          eq(resources.cleanupPolicy, CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH),
          inArray(resources.resourceType, DIRECT_DELETE_RESOURCE_TYPES),
        ),
      )
      .returning({
        id: resources.id,
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
    const db = this.persistence.db
    const resources = this.persistence.tables.capsuleBranchResources
    const updatedResources = await db
      .update(resources)
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
          eq(resources.id, resourceId),
          eq(resources.status, CapsuleBranchResourceStatus.DELETING),
          eq(resources.lastOperationId, operationId),
          eq(resources.cleanupPolicy, CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH),
          inArray(resources.resourceType, DIRECT_DELETE_RESOURCE_TYPES),
        ),
      )
      .returning({
        id: resources.id,
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
    const db = this.persistence.db
    const resources = this.persistence.tables.capsuleBranchResources
    const details = createFailureDetails(error, context)
    const updatedResources = await db
      .update(resources)
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
          eq(resources.id, resourceId),
          eq(resources.status, CapsuleBranchResourceStatus.DELETING),
          eq(resources.lastOperationId, operationId),
          eq(resources.cleanupPolicy, CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH),
          inArray(resources.resourceType, DIRECT_DELETE_RESOURCE_TYPES),
        ),
      )
      .returning({
        id: resources.id,
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
    const db = this.persistence.db
    const resources = this.persistence.tables.capsuleBranchResources
    const updatedResources = await db
      .update(resources)
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
          eq(resources.id, resourceId),
          eq(resources.resourceType, CapsuleBranchResourceType.PROVISIONING_FILE),
          eq(resources.cleanupPolicy, CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH),
          eq(resources.status, CapsuleBranchResourceStatus.CREATED),
        ),
      )
      .returning({
        id: resources.id,
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
    const db = this.persistence.db
    const resources = this.persistence.tables.capsuleBranchResources
    const updatedResources = await db
      .update(resources)
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
          eq(resources.id, resourceId),
          eq(resources.resourceType, CapsuleBranchResourceType.PROVISIONING_FILE),
          eq(resources.cleanupPolicy, CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH),
          inArray(resources.status, BOOTSTRAP_DERIVED_DELETE_ELIGIBLE_RESOURCE_STATUSES),
        ),
      )
      .returning({
        id: resources.id,
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
    const db = this.persistence.db
    const resources = this.persistence.tables.capsuleBranchResources
    const updated = await db.update(resources).set(updateData).where(eq(resources.id, resourceId)).returning({
      id: resources.id,
    })
    if (updated.length !== 1) {
      throw new IncusError('Capsule branch resource was not found while recording its failure.', 'NOT_FOUND', {
        resourceId,
      })
    }
  }

  public async listBranchResources(ownerId: string, branchName: string) {
    const db = this.persistence.db
    const resources = this.persistence.tables.capsuleBranchResources
    return await db
      .select()
      .from(resources)
      .where(and(eq(resources.ownerId, ownerId), eq(resources.branchName, branchName)))
      .orderBy(asc(resources.createdAt), asc(resources.id))
  }

  public async listBranchResourceInventoryByBranchId(branchId: string): Promise<CapsuleBranchResourceInventoryRow[]> {
    const db = this.persistence.db
    const resources = this.persistence.tables.capsuleBranchResources
    return await db
      .select({
        id: resources.id,
        ownerId: resources.ownerId,
        branchId: resources.branchId,
        branchName: resources.branchName,
        provider: resources.provider,
        resourceType: resources.resourceType,
        resourceKey: resources.resourceKey,
        blueprintVolumeName: resources.blueprintVolumeName,
        status: resources.status,
        cleanupPolicy: resources.cleanupPolicy,
        metadata: resources.metadata,
        createdByOperationId: resources.createdByOperationId,
        lastOperationId: resources.lastOperationId,
      })
      .from(resources)
      .where(eq(resources.branchId, branchId))
      .orderBy(asc(resources.createdAt), asc(resources.id))
  }

  public async listBranchResourceInventories(
    branchIds: readonly string[],
  ): Promise<CapsuleBranchResourceInventoryRow[]> {
    if (branchIds.length === 0) {
      return []
    }
    const db = this.persistence.db
    const resources = this.persistence.tables.capsuleBranchResources
    return await db
      .select({
        id: resources.id,
        ownerId: resources.ownerId,
        branchId: resources.branchId,
        branchName: resources.branchName,
        provider: resources.provider,
        resourceType: resources.resourceType,
        resourceKey: resources.resourceKey,
        blueprintVolumeName: resources.blueprintVolumeName,
        status: resources.status,
        cleanupPolicy: resources.cleanupPolicy,
        metadata: resources.metadata,
        createdByOperationId: resources.createdByOperationId,
        lastOperationId: resources.lastOperationId,
      })
      .from(resources)
      .where(inArray(resources.branchId, [...branchIds]))
      .orderBy(asc(resources.branchId), asc(resources.createdAt), asc(resources.id))
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
      blueprintVolumeName: BranchResourceInput['blueprintVolumeName']
      metadata: Record<string, unknown> | null
    },
    input: BranchResourceInput,
  ): void {
    const expectedProvider = input.provider ?? DEFAULT_RESOURCE_PROVIDER
    const expectedMetadata = normalizedMetadata(input.metadata, 'requested capsule branch resource metadata')
    const existingIdentityDigest = resourceIdentityDigest(
      existing.provider,
      existing.blueprintVolumeName,
      existing.metadata,
      'existing capsule branch resource identity',
    )
    const expectedIdentityDigest = resourceIdentityDigest(
      expectedProvider,
      input.blueprintVolumeName,
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
      existing.blueprintVolumeName !== input.blueprintVolumeName ||
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
