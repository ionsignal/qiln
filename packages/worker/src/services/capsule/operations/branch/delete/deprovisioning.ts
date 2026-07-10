import {
  CapsuleBranchOperationRequestHashSchema,
  CapsuleBranchOperationStatus,
  CapsuleBranchResourceStatus,
  digestCanonicalJsonValue,
  type CapsuleBranchDeleteOutput,
  type CapsuleBranchOperationRequestHash,
  type CapsuleBranchOperationStatusValue,
  type CapsuleBranchResourceStatusValue,
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
    let branchRecordDeleted = false
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

          await this.deleteBranchInstance(project, accepted.operationId, plan.instance.resourceId, plan.instance.instanceName)
        },
      )
      await runStep(
        CapsuleBranchDeleteStepKey.DELETE_VOLUMES,
        {
          count: plan.volumes.length,
        },
        async () => {
          for (const volume of plan.volumes) {
            await this.deleteBranchVolume(project, accepted.operationId, volume)
          }
        },
      )
      await runStep(
        CapsuleBranchDeleteStepKey.MARK_PROVISIONING_FILES_DELETED,
        {
          count: plan.provisioningFileResourceIds.length,
        },
        async () => {
          for (const resourceId of plan.provisioningFileResourceIds) {
            await this.transitionResourceStatusBestEffort(resourceId, accepted.operationId, CapsuleBranchResourceStatus.DELETED)
          }
        },
      )
      await runStep(
        CapsuleBranchDeleteStepKey.DELETE_BRANCH_RECORD,
        {
          branchName: input.name,
        },
        async () => {
          await this.stores.branches.deleteBranch(input.ownerId, input.name)
          branchRecordDeleted = true
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
      const operationStatus = branchRecordDeleted ? CapsuleBranchOperationStatus.FAILED : CapsuleBranchOperationStatus.CLEANUP_REQUIRED
      if (!branchRecordDeleted) {
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
          branchFinalized: branchRecordDeleted,
          action: currentPhase === 'complete_operation' ? 'mark_operation_completed' : undefined,
        }),
      )
      throw error
    }
  }

  private async deleteBranchInstance(
    project: ScopedIncusProject,
    operationId: string,
    resourceId: string,
    instanceName: string,
  ): Promise<void> {
    await this.transitionResourceStatusBestEffort(resourceId, operationId, CapsuleBranchResourceStatus.DELETING)
    let instanceMissing = false
    try {
      await project.instances.stop(instanceName)
    } catch (error: unknown) {
      const detailCode = error instanceof IncusError ? readIncusErrorDetailCode(error) : undefined
      if (error instanceof IncusError && error.code === 'NOT_FOUND') {
        instanceMissing = true
      } else if (!(error instanceof IncusError && detailCode === 400)) {
        await this.markResourceErrorBestEffort(resourceId, operationId, error, {
          action: 'stop_instance_before_delete',
          instanceName,
        })
        throw error
      }
    }
    if (instanceMissing) {
      await this.transitionResourceStatusBestEffort(resourceId, operationId, CapsuleBranchResourceStatus.MISSING)
      return
    }
    try {
      await project.instances.delete(instanceName)
      await this.transitionResourceStatusBestEffort(resourceId, operationId, CapsuleBranchResourceStatus.DELETED)
    } catch (error: unknown) {
      if (error instanceof IncusError && error.code === 'NOT_FOUND') {
        await this.transitionResourceStatusBestEffort(resourceId, operationId, CapsuleBranchResourceStatus.MISSING)
        return
      }
      await this.markResourceErrorBestEffort(resourceId, operationId, error, {
        action: 'delete_instance',
        instanceName,
      })
      throw error
    }
  }

  private async deleteBranchVolume(project: ScopedIncusProject, operationId: string, volume: BranchDeleteVolumeTarget): Promise<void> {
    await this.transitionResourceStatusBestEffort(volume.resourceId, operationId, CapsuleBranchResourceStatus.DELETING)
    try {
      await project.storage.delete(volume.pool, volume.volumeName)
      await this.transitionResourceStatusBestEffort(volume.resourceId, operationId, CapsuleBranchResourceStatus.DELETED)
    } catch (error: unknown) {
      if (error instanceof IncusError && error.code === 'NOT_FOUND') {
        await this.transitionResourceStatusBestEffort(volume.resourceId, operationId, CapsuleBranchResourceStatus.MISSING)
        return
      }
      await this.markResourceErrorBestEffort(volume.resourceId, operationId, error, {
        action: 'delete_volume',
        pool: volume.pool,
        volumeName: volume.volumeName,
      })
      throw error
    }
  }

  private async transitionResourceStatusBestEffort(
    resourceId: string,
    operationId: string,
    status: CapsuleBranchResourceStatusValue,
  ): Promise<void> {
    try {
      await this.stores.resources.transitionBranchResourceStatusForOperation(resourceId, operationId, status)
    } catch (error: unknown) {
      console.error(`[CapsuleBranchDeleteOperation] Failed to mark resource '${resourceId}' as '${status}'.`, error)
    }
  }

  private async markResourceErrorBestEffort(
    resourceId: string,
    operationId: string,
    error: unknown,
    context?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.stores.resources.markBranchResourceErrorForOperation(resourceId, operationId, error, context)
    } catch (dbError: unknown) {
      console.error(`[CapsuleBranchDeleteOperation] Failed to persist resource error for '${resourceId}'.`, dbError)
    }
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
