import {
  CapsuleBranchOperationRequestHashSchema,
  CapsuleBranchOperationStatus,
  digestCanonicalJsonValue,
  type CapsuleBranchDeleteOutput,
  type CapsuleBranchOperationRequestHash,
  type CapsuleBranchOperationStatusValue,
} from '@qiln/core/server'
import { IncusError, readIncusErrorDetailCode } from '../../../../../errors'
import { InlineOperationStepExecutor } from '../../inlineStepExecutor'
import { createOperationFailureContext } from '../../errors'
import { CapsuleBranchDeleteStepKey } from './steps'
import { assertCapsuleBranchResourceInventoryMatches, type CapsuleBranchResourceInventoryEntry } from '../../../resources/inventory'
import type { CapsuleBranchEventPublisher } from '../../../branch/events'
import type {
  CapsuleBranchOperationStepStore,
  CapsuleBranchOperationStore,
  CapsuleBranchResourceStore,
  CapsuleBranchStore,
} from '../../../stores'
import type { CapsuleBranchDeletePlanner } from './planner'
import type { IncusClient } from '../../../../../incus/client/index'
import type { BranchDeletePlan, BranchDeleteResourceRow, BranchDeleteOperationInput, BranchDeleteVolumeTarget } from './types'

export type ResolveCapsuleOwnerNamespace = (ownerId: string) => string

export interface CapsuleBranchDeleteOperationStores {
  branches: CapsuleBranchStore
  operations: CapsuleBranchOperationStore
  steps: CapsuleBranchOperationStepStore
  resources: CapsuleBranchResourceStore
}

type ScopedIncusProject = ReturnType<IncusClient['UseProject']>

interface BranchDeleteRequestHashInput {
  name: string
}

function createBranchDeleteRequestHash(input: BranchDeleteRequestHashInput): CapsuleBranchOperationRequestHash {
  const digest = digestCanonicalJsonValue(
    {
      operationType: 'delete',
      ...input,
    },
    {
      context: 'capsule branch delete request',
    },
  )
  return CapsuleBranchOperationRequestHashSchema.parse(digest)
}

function toInventoryEntries(resources: readonly BranchDeleteResourceRow[]): CapsuleBranchResourceInventoryEntry[] {
  return resources.map(resource => ({
    provider: resource.provider,
    resourceType: resource.resourceType,
    resourceKey: resource.resourceKey,
    cleanupPolicy: resource.cleanupPolicy,
    metadata: resource.metadata,
  }))
}

/**
 * Inline durable branch delete operation.
 *
 * This operation is deliberately fail closed. Every direct Incus deletion has a durable `deleting` intent fence and a
 * durable terminal outcome fence. If Qiln cannot persist either fence, it stops and leaves the branch runtime for
 * manual cleanup rather than retiring an uncertain runtime.
 */
export class CapsuleBranchDeprovisioningOperation {
  private readonly stepExecutor: InlineOperationStepExecutor

  constructor(
    private readonly stores: CapsuleBranchDeleteOperationStores,
    private readonly planner: CapsuleBranchDeletePlanner,
    private readonly incus: IncusClient,
    private readonly events: CapsuleBranchEventPublisher,
    private readonly resolveNamespace: ResolveCapsuleOwnerNamespace,
  ) {
    this.stepExecutor = new InlineOperationStepExecutor(this.stores.steps)
  }

  public async execute(input: BranchDeleteOperationInput): Promise<CapsuleBranchDeleteOutput> {
    const requestHash = createBranchDeleteRequestHash({
      name: input.name,
    })
    const existingReceipt = await this.stores.operations.findExistingBranchDeleteOperationReceipt(
      input.ownerId,
      input.idempotencyKey,
      requestHash,
    )
    if (existingReceipt) {
      return existingReceipt
    }
    const accepted = await this.stores.operations.acceptBranchDeleteOperation({
      ownerId: input.ownerId,
      name: input.name,
      idempotencyKey: input.idempotencyKey,
      requestHash,
    })
    if (accepted.replayedReceipt) {
      return accepted.replayedReceipt
    }
    const namespace = this.resolveNamespace(input.ownerId)
    const operationContext = {
      operationId: accepted.operationId,
      ownerId: input.ownerId,
      branchId: accepted.branchId,
      branchName: input.name,
    }
    let currentPhase: CapsuleBranchDeleteStepKey | 'complete_operation' = CapsuleBranchDeleteStepKey.PLAN_DELETE
    let currentStepKey: CapsuleBranchDeleteStepKey | null = null
    let branchRuntimeArchived = false
    const runStep = async <TResult>(
      stepKey: CapsuleBranchDeleteStepKey,
      metadata: Record<string, unknown>,
      action: () => Promise<TResult> | TResult,
    ): Promise<TResult> => {
      currentPhase = stepKey
      currentStepKey = stepKey
      return await this.stepExecutor.run(
        {
          ...operationContext,
          stepKey,
          metadata,
        },
        action,
      )
    }
    try {
      this.events.publishStateChanged(input.ownerId, input.name, 'deleting')
      const plan = await runStep(
        CapsuleBranchDeleteStepKey.PLAN_DELETE,
        {
          branchId: accepted.branchId,
          hasResourceInventoryDigest: accepted.resourceInventoryDigest !== null,
        },
        async (): Promise<BranchDeletePlan> => {
          if (!accepted.resourceInventoryDigest) {
            throw new IncusError('Capsule branch has no verified durable resource inventory. Manual review is required.', 'CONFLICT', {
              operationId: accepted.operationId,
              branchId: accepted.branchId,
              branchName: input.name,
              reason: 'missing_resource_inventory_digest',
            })
          }
          const resources = await this.stores.resources.listBranchResourceInventoryByBranchId(accepted.branchId)
          assertCapsuleBranchResourceInventoryMatches(accepted.resourceInventoryDigest, toInventoryEntries(resources))
          return this.planner.createPlan({
            branchName: input.name,
            namespace,
            resources,
          })
        },
      )
      const project = this.incus.UseProject(namespace)
      await runStep(
        CapsuleBranchDeleteStepKey.DELETE_INSTANCE,
        {
          resourceId: plan.instance?.resourceId ?? null,
          instanceName: plan.instance?.instanceName ?? null,
        },
        async () => {
          if (!plan.instance) {
            return
          }
          await this.deleteInstanceWithLedgerFence(project, accepted.operationId, plan.instance.resourceId, plan.instance.instanceName)
        },
      )
      await runStep(
        CapsuleBranchDeleteStepKey.DELETE_VOLUMES,
        {
          count: plan.volumes.length,
        },
        async () => {
          for (const volume of plan.volumes) {
            await this.deleteVolumeWithLedgerFence(project, accepted.operationId, volume)
          }
        },
      )
      await runStep(
        CapsuleBranchDeleteStepKey.FINALIZE_DERIVED_RESOURCE_OUTCOMES,
        {
          provisioningFileResourceCount: plan.provisioningFileResourceIdsToFinalize.length,
        },
        async () => {
          for (const resourceId of plan.provisioningFileResourceIdsToFinalize) {
            await this.stores.resources.recordDerivedBranchResourceDeletion(resourceId, accepted.operationId)
          }
        },
      )
      await runStep(
        CapsuleBranchDeleteStepKey.ARCHIVE_BRANCH_RUNTIME,
        {
          branchId: accepted.branchId,
          status: 'archived',
        },
        async () => {
          await this.stores.branches.archiveBranchRuntime(input.ownerId, accepted.branchId)
          branchRuntimeArchived = true
          this.events.publishDeleted(input.ownerId, input.name)
        },
      )
      currentPhase = 'complete_operation'
      currentStepKey = null
      await this.stores.operations.transitionBranchOperationStatus(accepted.operationId, CapsuleBranchOperationStatus.COMPLETED)
      return this.stores.operations.createBranchDeleteOutput(
        accepted.operationId,
        CapsuleBranchOperationStatus.COMPLETED,
        input.name,
        true,
        false,
      )
    } catch (error: unknown) {
      const operationStatus = branchRuntimeArchived ? CapsuleBranchOperationStatus.FAILED : CapsuleBranchOperationStatus.CLEANUP_REQUIRED
      if (!branchRuntimeArchived) {
        await this.markBranchCleanupRequiredBestEffort(input.ownerId, input.name)
      }
      await this.markOperationFailureBestEffort(
        accepted.operationId,
        operationStatus,
        error,
        createOperationFailureContext({
          operationId: accepted.operationId,
          branchName: input.name,
          phase: currentPhase,
          stepKey: currentStepKey,
          branchFinalized: branchRuntimeArchived,
          action: currentPhase === 'complete_operation' ? 'mark_operation_completed' : undefined,
        }),
      )
      throw error
    }
  }

  private async deleteInstanceWithLedgerFence(
    project: ScopedIncusProject,
    operationId: string,
    resourceId: string,
    instanceName: string,
  ): Promise<void> {
    await this.stores.resources.recordBranchResourceDeleteIntent(resourceId, operationId)
    try {
      await project.instances.stop(instanceName)
    } catch (error: unknown) {
      const detailCode = error instanceof IncusError ? readIncusErrorDetailCode(error) : undefined
      if (error instanceof IncusError && error.code === 'NOT_FOUND') {
        await this.stores.resources.recordBranchResourceDeleteOutcome(resourceId, operationId, 'missing')
        return
      }
      if (!(error instanceof IncusError && detailCode === 400)) {
        await this.stores.resources.recordBranchResourceDeleteFailure(resourceId, operationId, error, {
          action: 'stop_instance_before_delete',
          instanceName,
        })
        throw error
      }
    }
    try {
      await project.instances.delete(instanceName)
    } catch (error: unknown) {
      if (error instanceof IncusError && error.code === 'NOT_FOUND') {
        await this.stores.resources.recordBranchResourceDeleteOutcome(resourceId, operationId, 'missing')
        return
      }
      await this.stores.resources.recordBranchResourceDeleteFailure(resourceId, operationId, error, {
        action: 'delete_instance',
        instanceName,
      })
      throw error
    }
    await this.stores.resources.recordBranchResourceDeleteOutcome(resourceId, operationId, 'deleted')
  }

  private async deleteVolumeWithLedgerFence(project: ScopedIncusProject, operationId: string, volume: BranchDeleteVolumeTarget): Promise<void> {
    await this.stores.resources.recordBranchResourceDeleteIntent(volume.resourceId, operationId)
    try {
      await project.storage.delete(volume.pool, volume.volumeName)
    } catch (error: unknown) {
      if (error instanceof IncusError && error.code === 'NOT_FOUND') {
        await this.stores.resources.recordBranchResourceDeleteOutcome(volume.resourceId, operationId, 'missing')
        return
      }
      await this.stores.resources.recordBranchResourceDeleteFailure(volume.resourceId, operationId, error, {
        action: 'delete_volume',
        pool: volume.pool,
        volumeName: volume.volumeName,
      })
      throw error
    }
    await this.stores.resources.recordBranchResourceDeleteOutcome(volume.resourceId, operationId, 'deleted')
  }

  private async markBranchCleanupRequiredBestEffort(ownerId: string, branchName: string): Promise<void> {
    try {
      await this.stores.branches.transitionBranchState(ownerId, branchName, 'cleanup_required')
      this.events.publishStateChanged(ownerId, branchName, 'cleanup_required')
    } catch (error: unknown) {
      console.error(`[CapsuleBranchDeleteOperation] Failed to mark branch '${branchName}' cleanup_required.`, error)
    }
  }

  private async markOperationFailureBestEffort(
    operationId: string,
    status: CapsuleBranchOperationStatusValue,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.stores.operations.markBranchOperationFailure(operationId, status, error, context)
    } catch (dbError: unknown) {
      console.error(`[CapsuleBranchDeleteOperation] Failed to persist operation failure for '${operationId}'.`, dbError)
    }
  }
}
