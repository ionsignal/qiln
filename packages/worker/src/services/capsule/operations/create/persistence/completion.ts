import { and, eq } from 'drizzle-orm'
import {
  CapsuleBranchResourceStatus,
  CapsuleBranchResourceType,
  CapsuleOperationStatus,
  CapsuleOperationType,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { toCreateTerminalResult } from './result'
import type { CapsuleCreateTerminalResult } from '../types'
import type { CapsuleCreateInventoryPolicy } from '../policy/inventory'
import type { CapsuleCreateResourceLineage } from '../resource/lineage'
import type { CapsuleCreateLocks } from './locks'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

/**
 * Commits successful capsule creation only after locked PostgreSQL evidence
 * proves the exact deterministic resource plan reached its expected terminal
 * accounting states.
 *
 * This boundary performs no live Incus discovery. Provider state that cannot be
 * proven from the durable ledger must be classified cleanup-required instead.
 */
export class CapsuleCreateCompletion<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly locks: CapsuleCreateLocks<TDatabase, TTables>,
    private readonly lineage: CapsuleCreateResourceLineage<TTables>,
    private readonly inventory: CapsuleCreateInventoryPolicy<TTables>,
  ) {}

  public async complete(operationId: string): Promise<CapsuleCreateTerminalResult> {
    const { capsuleOperations, capsules, capsuleBranches } = this.persistence.tables
    return await this.persistence.db.transaction(async tx => {
      const operation = await this.locks.operation(tx, operationId)
      if (
        operation.status !== CapsuleOperationStatus.RUNNING ||
        operation.executionStartedAt === null ||
        operation.providerMutationStartedAt === null ||
        operation.completedAt !== null ||
        operation.failedAt !== null ||
        operation.failureCode !== null ||
        operation.failureMessage !== null ||
        operation.failureDetails !== null
      ) {
        throw new IncusError('Capsule create operation is not eligible for successful completion.', 'CONFLICT', {
          operationId,
          operationStatus: operation.status,
          hasProviderIntent: operation.providerMutationStartedAt !== null,
        })
      }
      const extension = await this.locks.extension(tx, operation.id)
      const capsule = await this.locks.capsule(tx, operation.ownerId, operation.capsuleId)
      const branches = await this.locks.rootBranches(tx, operation.capsuleId, extension.rootBranchId)
      const lineage = this.lineage.validate(operation, extension, branches)
      const rootBranch = lineage.rootBranch
      const resources = await this.locks.resources(tx, operation.id, [rootBranch.id])
      if (
        capsule.lifecycleStatus !== 'provisioning' ||
        capsule.archivedAt !== null ||
        rootBranch.status !== 'provisioning'
      ) {
        throw new IncusError('Capsule create aggregate is not eligible for completion.', 'CONFLICT', {
          operationId,
          capsuleStatus: capsule.lifecycleStatus,
          branchStatus: rootBranch.status,
          rootBranchId: rootBranch.id,
        })
      }
      this.inventory.assertComplete(operation.id, lineage, resources)
      for (const resource of resources) {
        const expectedStatus =
          resource.resourceType === CapsuleBranchResourceType.INCUS_PROJECT ||
          resource.resourceType === CapsuleBranchResourceType.BIND_MOUNT
            ? CapsuleBranchResourceStatus.ADOPTED
            : CapsuleBranchResourceStatus.CREATED
        if (
          resource.status !== expectedStatus ||
          resource.failureCode !== null ||
          resource.failureMessage !== null ||
          resource.failureDetails !== null
        ) {
          throw new IncusError('Capsule create resource has not reached its required terminal outcome.', 'CONFLICT', {
            operationId,
            resourceId: resource.id,
            resourceKey: resource.resourceKey,
            expectedStatus,
            actualStatus: resource.status,
          })
        }
      }
      const now = new Date()
      const [completedOperation] = await tx
        .update(capsuleOperations)
        .set({
          status: CapsuleOperationStatus.COMPLETED,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleOperations.id, operation.id),
            eq(capsuleOperations.type, CapsuleOperationType.CREATE),
            eq(capsuleOperations.status, CapsuleOperationStatus.RUNNING),
          ),
        )
        .returning()
      const [activeCapsule] = await tx
        .update(capsules)
        .set({
          lifecycleStatus: 'active',
          updatedAt: now,
        })
        .where(
          and(
            eq(capsules.id, operation.capsuleId),
            eq(capsules.ownerId, operation.ownerId),
            eq(capsules.lifecycleStatus, 'provisioning'),
          ),
        )
        .returning()
      const [offlineBranch] = await tx
        .update(capsuleBranches)
        .set({
          status: 'offline',
          runtimeIp: null,
          runtimeErrorCode: null,
          runtimeErrorMessage: null,
          runtimeErrorDetails: null,
          runtimeErrorAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(capsuleBranches.id, rootBranch.id),
            eq(capsuleBranches.ownerId, operation.ownerId),
            eq(capsuleBranches.capsuleId, operation.capsuleId),
            eq(capsuleBranches.status, 'provisioning'),
            eq(capsuleBranches.isRootBranch, true),
          ),
        )
        .returning()
      if (!completedOperation || !activeCapsule || !offlineBranch) {
        throw new IncusError('Failed to atomically finalize capsule creation.', 'CONFLICT', {
          operationId,
        })
      }
      return toCreateTerminalResult<TTables>(completedOperation, activeCapsule, offlineBranch)
    })
  }
}
