import { and, eq, isNull } from 'drizzle-orm'
import {
  CapsuleBranchResourceInventoryDigestSchema,
  CapsuleOperationStatus,
  CapsuleOperationType,
  type CapsuleBranchResourceInventoryDigest,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { toCreateOperationTransition } from './result'
import type { CapsuleOperationTransitionOutput } from '../../shared'
import type { CreateCapsuleLineagePolicy } from '../policy/lineage'
import type { CreateCapsuleExecutionInput } from '../types'
import type { CreateCapsuleLocks, CreateTransaction } from './locks'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

/**
 * Owns durable execution input, claim, inventory proof, and provider intent.
 *
 * Each authority boundary validates its locked operation and lineage. Provider
 * execution cannot reuse a transport payload as immutable execution authority.
 */
export class CreateCapsuleExecution<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly locks: CreateCapsuleLocks<TDatabase, TTables>,
    private readonly lineage: CreateCapsuleLineagePolicy<TTables>,
  ) {}

  public async loadExecution(operationId: string): Promise<CreateCapsuleExecutionInput> {
    return await this.persistence.db.transaction(async tx => {
      const { operation, lineage } = await this.lockInput(tx, operationId, CapsuleOperationStatus.ACCEPTED)
      return {
        operationId: operation.id,
        capsuleId: operation.capsuleId,
        ownerId: operation.ownerId,
        rootBranchId: lineage.rootBranch.id,
        rootBranchName: lineage.extension.rootBranchName,
        blueprintName: lineage.extension.blueprintName,
        blueprintDigest: lineage.blueprintDigest,
        blueprintSnapshot: lineage.blueprint,
        rootfsImagePin: lineage.rootfsImagePin,
        cpu: lineage.extension.cpu,
        memory: lineage.extension.memory,
      }
    })
  }

  public async claim(operationId: string): Promise<CapsuleOperationTransitionOutput> {
    const operations = this.persistence.tables.capsuleOperations
    return await this.persistence.db.transaction(async tx => {
      await this.lockInput(tx, operationId, CapsuleOperationStatus.ACCEPTED)
      const now = new Date()
      const [claimed] = await tx
        .update(operations)
        .set({
          status: CapsuleOperationStatus.RUNNING,
          executionStartedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(operations.id, operationId),
            eq(operations.type, CapsuleOperationType.CREATE),
            eq(operations.status, CapsuleOperationStatus.ACCEPTED),
            isNull(operations.providerMutationStartedAt),
          ),
        )
        .returning()
      if (!claimed) {
        throw new IncusError('Capsule create operation could not be claimed from accepted to running.', 'CONFLICT', {
          operationId,
        })
      }
      return toCreateOperationTransition(claimed)
    })
  }

  /**
   * Records the complete planned inventory digest before provider intent.
   *
   * Branch identity is derived from locked create lineage rather than supplied
   * independently by the executor.
   */
  public async recordInventory(operationId: string, digest: CapsuleBranchResourceInventoryDigest): Promise<void> {
    const parsedDigest = CapsuleBranchResourceInventoryDigestSchema.safeParse(digest)
    if (!parsedDigest.success) {
      throw new IncusError('Capsule create resource inventory digest is invalid.', 'VALIDATION_ERROR', {
        operationId,
      })
    }
    const branches = this.persistence.tables.capsuleBranches
    await this.persistence.db.transaction(async tx => {
      const { lineage } = await this.lockInput(tx, operationId, CapsuleOperationStatus.RUNNING)
      if (lineage.rootBranch.resourceInventoryDigest !== null) {
        throw new IncusError('Capsule create resource inventory proof has already been recorded.', 'CONFLICT', {
          operationId,
          rootBranchId: lineage.rootBranch.id,
        })
      }
      const [updated] = await tx
        .update(branches)
        .set({
          resourceInventoryDigest: parsedDigest.data,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(branches.id, lineage.rootBranch.id),
            eq(branches.status, 'provisioning'),
            isNull(branches.resourceInventoryDigest),
          ),
        )
        .returning({
          id: branches.id,
        })
      if (!updated) {
        throw new IncusError('Failed to persist the root branch resource inventory proof.', 'CONFLICT', {
          operationId,
          rootBranchId: lineage.rootBranch.id,
        })
      }
    })
  }

  /**
   * Commits the operation-wide provider-intent fence.
   *
   * This write must complete before namespace creation or any other Incus
   * state-changing call.
   */
  public async commitProviderIntent(operationId: string): Promise<void> {
    const operations = this.persistence.tables.capsuleOperations
    await this.persistence.db.transaction(async tx => {
      const { lineage } = await this.lockInput(tx, operationId, CapsuleOperationStatus.RUNNING)
      if (!CapsuleBranchResourceInventoryDigestSchema.safeParse(lineage.rootBranch.resourceInventoryDigest).success) {
        throw new IncusError(
          'Capsule create requires a valid resource inventory proof before provider intent.',
          'CONFLICT',
          {
            operationId,
            rootBranchId: lineage.rootBranch.id,
          },
        )
      }
      const now = new Date()
      const [updated] = await tx
        .update(operations)
        .set({
          providerMutationStartedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(operations.id, operationId),
            eq(operations.type, CapsuleOperationType.CREATE),
            eq(operations.status, CapsuleOperationStatus.RUNNING),
            isNull(operations.providerMutationStartedAt),
          ),
        )
        .returning({
          id: operations.id,
        })
      if (!updated) {
        throw new IncusError('Failed to commit the capsule create provider-intent fence.', 'CONFLICT', {
          operationId,
        })
      }
    })
  }

  private async lockInput(
    tx: CreateTransaction<TDatabase>,
    operationId: string,
    requiredStatus: typeof CapsuleOperationStatus.ACCEPTED | typeof CapsuleOperationStatus.RUNNING,
  ) {
    const operation = await this.locks.operation(tx, operationId)
    if (
      operation.status !== requiredStatus ||
      operation.providerMutationStartedAt !== null ||
      operation.completedAt !== null ||
      operation.failedAt !== null
    ) {
      throw new IncusError(
        'Capsule create operation is not eligible for this pre-provider execution boundary.',
        'CONFLICT',
        {
          operationId,
          requiredStatus,
          operationStatus: operation.status,
          providerIntentRecorded: operation.providerMutationStartedAt !== null,
        },
      )
    }
    const extension = await this.locks.extension(tx, operation.id)
    const capsule = await this.locks.capsule(tx, operation.ownerId, operation.capsuleId)
    const branches = await this.locks.rootBranches(tx, operation.capsuleId, extension.rootBranchId)
    const lineage = this.lineage.validate(operation, extension, branches)
    if (
      capsule.lifecycleStatus !== 'provisioning' ||
      capsule.archivedAt !== null ||
      lineage.rootBranch.status !== 'provisioning'
    ) {
      throw new IncusError('Capsule create aggregate is not eligible for execution.', 'CONFLICT', {
        operationId,
        capsuleStatus: capsule.lifecycleStatus,
        capsuleArchived: capsule.archivedAt !== null,
        rootBranchId: lineage.rootBranch.id,
        rootBranchStatus: lineage.rootBranch.status,
      })
    }
    return {
      operation,
      lineage,
    }
  }
}
