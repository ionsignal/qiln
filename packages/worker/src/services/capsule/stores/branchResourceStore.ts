import { and, eq, inArray } from 'drizzle-orm'
import {
  CapsuleBranchResourceStatus,
  CapsuleBranchResourceType,
  capsuleBranchResourcesTable,
  type CapsuleHostDbContract,
} from '@qiln/core/server'
import { IncusError, isUniqueConstraintViolation } from '../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from './errorDetails'
import { toJsonObject } from './jsonPersistence'
import type { BranchResourceInput } from './types'

const CREATE_INTENT_ELIGIBLE_RESOURCE_STATUSES = [CapsuleBranchResourceStatus.PLANNED] as const
const DELETE_INTENT_ELIGIBLE_RESOURCE_STATUSES = [CapsuleBranchResourceStatus.CREATED, CapsuleBranchResourceStatus.ADOPTED] as const
const DIRECT_DELETE_OUTCOME_RESOURCE_STATUSES = [CapsuleBranchResourceStatus.DELETED, CapsuleBranchResourceStatus.MISSING] as const
const DERIVED_DELETE_OUTCOME_ELIGIBLE_RESOURCE_STATUSES = [
  CapsuleBranchResourceStatus.PLANNED,
  CapsuleBranchResourceStatus.CREATING,
  CapsuleBranchResourceStatus.CREATED,
  CapsuleBranchResourceStatus.ADOPTED,
  CapsuleBranchResourceStatus.ERROR,
] as const

type DirectDeleteOutcomeResourceStatus = (typeof DIRECT_DELETE_OUTCOME_RESOURCE_STATUSES)[number]

/**
 * Persistence boundary for branch-owned resources.
 *
 * Resource rows are the durable inventory of external/provider resources touched by branch operations.
 * Provider mutations must persist their intent before contacting Incus and their durable outcome before
 * a branch operation can finalize. This store deliberately does not provide broad public status setters
 * that could bypass those ownership fences.
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
   * Ensures a durable planned-resource row exists before an operation evaluates whether that resource is an adopted dependency or a provider mutation target.
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
        status: CapsuleBranchResourceStatus.PLANNED,
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

  /**
   * Marks a retained or external dependency as present without claiming that the
   * current branch operation created it. Retained namespaces and bind mounts use
   * this state because branch cleanup must never attempt to delete them.
   */
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
      throw new IncusError('Failed to persist capsule branch resource adoption. Manual review is required.', 'CONFLICT', {
        resourceId,
        operationId,
      })
    }
  }

  /**
   * Persists an intent fence before Qiln starts a provider mutation that creates
   * a branch-owned resource or writes a branch-owned provisioning file.
   */
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
      throw new IncusError('Failed to persist capsule branch resource create intent. Manual review is required.', 'CONFLICT', {
        resourceId,
        operationId,
      })
    }
  }

  /**
   * Records that the provider mutation completed and that this operation now has
   * durable ownership proof required for future compensation.
   */
  public async recordBranchResourceCreateOutcome(resourceId: string, operationId: string): Promise<void> {
    const updatedResources = await this.db
      .update(capsuleBranchResourcesTable)
      .set({
        status: CapsuleBranchResourceStatus.CREATED,
        lastOperationId: operationId,
        updatedAt: new Date(),
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
      throw new IncusError('Failed to persist capsule branch resource create outcome. Manual review is required.', 'CONFLICT', {
        resourceId,
        operationId,
      })
    }
  }

  /**
   * Records a provider or outcome-persistence failure after creation intent was
   * durable. If this cannot be persisted, callers must treat the resource as
   * uncertain and stop before normal branch finalization.
   */
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
        failureDetails: details === undefined ? undefined : toJsonObject(details, 'capsule branch resource create failure details'),
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
      throw new IncusError('Failed to persist capsule branch resource create failure. Manual review is required.', 'CONFLICT', {
        resourceId,
        operationId,
      })
    }
  }

  /**
   * Records the durable intent to delete a provider-owned resource before the worker contacts Incus.
   * A destructive provider mutation must not begin if this conditional transition cannot be persisted.
   */
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
          inArray(capsuleBranchResourcesTable.status, DELETE_INTENT_ELIGIBLE_RESOURCE_STATUSES),
        ),
      )
      .returning({
        id: capsuleBranchResourcesTable.id,
      })
    if (updatedResources.length !== 1) {
      throw new IncusError('Failed to persist capsule branch resource delete intent. Manual review is required.', 'CONFLICT', {
        resourceId,
        operationId,
      })
    }
  }

  /**
   * Records the terminal outcome of a direct Incus deletion after the provider mutation has completed
   * or Incus has proven the target is already absent.
   */
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
      })
      .where(
        and(
          eq(capsuleBranchResourcesTable.id, resourceId),
          eq(capsuleBranchResourcesTable.status, CapsuleBranchResourceStatus.DELETING),
          eq(capsuleBranchResourcesTable.lastOperationId, operationId),
        ),
      )
      .returning({
        id: capsuleBranchResourcesTable.id,
      })
    if (updatedResources.length !== 1) {
      throw new IncusError('Failed to persist capsule branch resource delete outcome. Manual review is required.', 'CONFLICT', {
        resourceId,
        operationId,
        outcome,
      })
    }
  }

  /**
   * Records a provider failure after delete intent was durably persisted.
   *
   * This is intentionally strict: if the failure cannot be recorded, callers must stop before branch
   * runtime finalization because Qiln cannot prove the provider resource's final state.
   */
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
        failureDetails: details === undefined ? undefined : toJsonObject(details, 'capsule branch resource delete failure details'),
      })
      .where(
        and(
          eq(capsuleBranchResourcesTable.id, resourceId),
          eq(capsuleBranchResourcesTable.status, CapsuleBranchResourceStatus.DELETING),
          eq(capsuleBranchResourcesTable.lastOperationId, operationId),
        ),
      )
      .returning({
        id: capsuleBranchResourcesTable.id,
      })
    if (updatedResources.length !== 1) {
      throw new IncusError('Failed to persist capsule branch resource delete failure. Manual review is required.', 'CONFLICT', {
        resourceId,
        operationId,
      })
    }
  }

  /**
   * Finalizes a provisioning-file ledger resource once its owning instance or managed volume has a
   * durable terminal deletion outcome. Qiln does not issue an independent provider file-delete call,
   * so the file itself intentionally does not pass through `deleting`.
   */
  public async recordDerivedBranchResourceDeletion(resourceId: string, operationId: string): Promise<void> {
    const updatedResources = await this.db
      .update(capsuleBranchResourcesTable)
      .set({
        status: CapsuleBranchResourceStatus.DELETED,
        lastOperationId: operationId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(capsuleBranchResourcesTable.id, resourceId),
          eq(capsuleBranchResourcesTable.resourceType, CapsuleBranchResourceType.PROVISIONING_FILE),
          inArray(capsuleBranchResourcesTable.status, DERIVED_DELETE_OUTCOME_ELIGIBLE_RESOURCE_STATUSES),
        ),
      )
      .returning({
        id: capsuleBranchResourcesTable.id,
      })

    if (updatedResources.length !== 1) {
      throw new IncusError('Failed to persist derived capsule branch resource deletion. Manual review is required.', 'CONFLICT', {
        resourceId,
        operationId,
      })
    }
  }

  /**
   * Best-effort error recording is retained for non-provider dependency accounting,
   * such as a retained namespace whose adoption record could not be finalized.
   * Direct provider create/delete paths must use the strict fenced methods above.
   */
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
    await this.db
      .update(capsuleBranchResourcesTable)
      .set(updateData)
      .where(and(eq(capsuleBranchResourcesTable.id, resourceId)))
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

  public async listBranchResourceInventoryByBranchId(branchId: string) {
    return await this.db.query.capsuleBranchResources.findMany({
      where: {
        branchId,
      },
      orderBy: (capsuleBranchResources, { asc }) => [asc(capsuleBranchResources.createdAt)],
    })
  }
}
