import { and, eq, isNull } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { createCapsuleBranchResourceInventoryDigest } from '../../../resource/inventory'
import { createResourceInventoryEntries } from '../../../resource/plan'
import { toCreateOperationTransition } from './result'
import type { CapsuleOperationTransitionOutput } from '../../shared'
import type { CreateCapsuleInventoryPolicy } from '../policy/inventory'
import type { CreateResourceLineage } from '../../../resource/lineage'
import type { CreateCapsuleExecutionInput } from '../types'
import type { CreateCapsuleLocks, CreateTransaction } from './locks'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

/**
 * Owns durable execution input, claim, complete inventory, and provider intent.
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
    private readonly lineage: CreateResourceLineage<TTables>,
    private readonly inventory: CreateCapsuleInventoryPolicy,
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
   * Commits every planned identity and its digest in one transaction.
   *
   * This is initial materialization, not recovery or replay. Existing partial
   * evidence must remain visible for conservative failure classification.
   */
  public async materialize(operationId: string): Promise<void> {
    const { capsuleBranches, capsuleBranchResources } = this.persistence.tables
    await this.persistence.db.transaction(async tx => {
      const { operation, lineage } = await this.lockInput(tx, operationId, CapsuleOperationStatus.RUNNING)
      const existing = await this.locks.resources(tx, operation.id, [lineage.rootBranch.id])
      if (lineage.rootBranch.resourceInventoryDigest !== null || existing.length > 0) {
        throw new IncusError('Capsule create inventory already contains durable evidence.', 'CONFLICT', {
          operationId,
          rootBranchId: lineage.rootBranch.id,
          resourceCount: existing.length,
        })
      }
      const plan = this.inventory.plan(lineage)
      const entries = createResourceInventoryEntries(plan)
      const digest = createCapsuleBranchResourceInventoryDigest(entries, 'capsule create planned resource inventory')
      const now = new Date()
      const [branch] = await tx
        .update(capsuleBranches)
        .set({
          resourceInventoryDigest: digest,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleBranches.id, lineage.rootBranch.id),
            eq(capsuleBranches.status, 'provisioning'),
            isNull(capsuleBranches.resourceInventoryDigest),
          ),
        )
        .returning()
      if (!branch) {
        throw new IncusError('Failed to persist the root branch resource inventory proof.', 'CONFLICT', {
          operationId,
          rootBranchId: lineage.rootBranch.id,
        })
      }
      await tx.insert(capsuleBranchResources).values(
        entries.map(entry => ({
          ownerId: operation.ownerId,
          branchId: branch.id,
          branchName: branch.name,
          createdByOperationId: operation.id,
          lastOperationId: operation.id,
          provider: entry.provider,
          resourceType: entry.resourceType,
          resourceKey: entry.resourceKey,
          blueprintVolumeName: entry.blueprintVolumeName,
          cleanupPolicy: entry.cleanupPolicy,
          metadata: entry.metadata as Record<string, unknown>,
          status: 'planned' as const,
          createdAt: now,
          updatedAt: now,
        })),
      )
      const resources = await this.locks.resources(tx, operation.id, [branch.id])
      this.inventory.assertComplete(operation.id, { ...lineage, rootBranch: branch }, resources, true)
    })
  }

  /**
   * Commits the operation-wide provider-intent fence.
   *
   * The complete untouched ledger must be proven again under the same locks.
   * This write must complete before namespace creation or any other Incus
   * state-changing call.
   */
  public async commitProviderIntent(operationId: string): Promise<void> {
    const operations = this.persistence.tables.capsuleOperations
    await this.persistence.db.transaction(async tx => {
      const { operation, lineage } = await this.lockInput(tx, operationId, CapsuleOperationStatus.RUNNING)
      const resources = await this.locks.resources(tx, operation.id, [lineage.rootBranch.id])
      this.inventory.assertComplete(operation.id, lineage, resources, true)
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
      operation.failedAt !== null ||
      operation.failureCode !== null ||
      operation.failureMessage !== null ||
      operation.failureDetails !== null ||
      (requiredStatus === CapsuleOperationStatus.ACCEPTED && operation.executionStartedAt !== null) ||
      (requiredStatus === CapsuleOperationStatus.RUNNING && operation.executionStartedAt === null)
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
