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
import { assertCapsuleBranchResourceInventoryMatches } from '../../../resource/inventory'
import { createResourceInventoryEntries, type CreateCapsuleResourcePlanner } from '../resource/plan'
import { toCreateTerminalResult } from './result'
import type { ProjectService } from '../../../../project'
import type { CreateCapsuleTerminalResult } from '../types'
import type { CreateCapsuleLineagePolicy, ValidatedCreateLineage } from '../policy/lineage'
import type { CreateCapsuleLocks } from './locks'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

type ResourceRow<TTables extends CapsuleTables> = TTables['capsuleBranchResources']['$inferSelect']

/**
 * Commits successful capsule creation only after locked PostgreSQL evidence
 * proves the exact deterministic resource plan reached its expected terminal
 * accounting states.
 *
 * This boundary performs no live Incus discovery. Provider state that cannot be
 * proven from the durable ledger must be classified cleanup-required instead.
 */
export class CreateCapsuleCompletion<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly locks: CreateCapsuleLocks<TDatabase, TTables>,
    private readonly lineage: CreateCapsuleLineagePolicy<TTables>,
    private readonly planner: CreateCapsuleResourcePlanner,
    private readonly projects: ProjectService,
  ) {}

  public async complete(operationId: string): Promise<CreateCapsuleTerminalResult> {
    const { capsuleOperations, capsules, capsuleBranches } = this.persistence.tables
    return await this.persistence.db.transaction(async tx => {
      const operation = await this.locks.operation(tx, operationId)
      if (
        operation.status !== CapsuleOperationStatus.RUNNING ||
        operation.providerMutationStartedAt === null ||
        operation.completedAt !== null ||
        operation.failedAt !== null
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

      this.proveResourceLedger(operation.id, operation.ownerId, lineage, resources)

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
      return toCreateTerminalResult(completedOperation, activeCapsule, offlineBranch)
    })
  }

  private proveResourceLedger(
    operationId: string,
    ownerId: string,
    lineage: ValidatedCreateLineage<TTables>,
    resources: ResourceRow<TTables>[],
  ): void {
    const rootBranch = lineage.rootBranch
    if (rootBranch.resourceInventoryDigest === null) {
      throw new IncusError('Capsule root branch has no durable resource inventory proof.', 'CONFLICT', {
        operationId,
        branchId: rootBranch.id,
      })
    }
    const plan = this.planner.plan({
      namespace: this.projects.getNamespace(ownerId),
      rootBranchId: rootBranch.id,
      rootBranchName: rootBranch.name,
      cpu: lineage.extension.cpu,
      memory: lineage.extension.memory,
      blueprint: lineage.blueprint,
      rootfsImagePin: lineage.rootfsImagePin,
    })

    assertCapsuleBranchResourceInventoryMatches(
      rootBranch.resourceInventoryDigest,
      createResourceInventoryEntries(plan),
    )

    assertCapsuleBranchResourceInventoryMatches(
      rootBranch.resourceInventoryDigest,
      resources.map(resource => ({
        provider: resource.provider,
        resourceType: resource.resourceType,
        resourceKey: resource.resourceKey,
        blueprintVolumeName: resource.blueprintVolumeName,
        cleanupPolicy: resource.cleanupPolicy,
        metadata: resource.metadata,
      })),
    )

    /**
     * The two canonical comparisons already prove the exact resource set and
     * its inventory fields. Attribution, mutable status, and failure fields are
     * deliberately outside that digest and require independent checks.
     */
    for (const resource of resources) {
      const expectedStatus =
        resource.resourceType === CapsuleBranchResourceType.INCUS_PROJECT ||
        resource.resourceType === CapsuleBranchResourceType.BIND_MOUNT
          ? CapsuleBranchResourceStatus.ADOPTED
          : CapsuleBranchResourceStatus.CREATED
      const attributionMatches =
        resource.ownerId === ownerId &&
        resource.branchId === rootBranch.id &&
        resource.branchName === rootBranch.name &&
        resource.createdByOperationId === operationId &&
        resource.lastOperationId === operationId
      const terminalStateMatches =
        resource.status === expectedStatus &&
        resource.failureCode === null &&
        resource.failureMessage === null &&
        resource.failureDetails === null
      if (!attributionMatches || !terminalStateMatches) {
        throw new IncusError(
          'Capsule create resource does not match its required attribution or terminal state.',
          'CONFLICT',
          {
            operationId,
            branchId: rootBranch.id,
            resourceId: resource.id,
            resourceKey: resource.resourceKey,
            expectedStatus,
            actualStatus: resource.status,
            attributionMatches,
            terminalStateMatches,
          },
        )
      }
    }
  }
}
