import {
  CapsuleBranchOperationRequestHashSchema,
  CapsuleBranchOperationStatus,
  CapsuleBranchResourceStatus,
  digestCanonicalJsonValue,
  type CapsuleBranchDeleteOutput,
  type CapsuleBranchOperationRequestHash,
  type CapsuleBranchOperationStatus as CapsuleBranchOperationStatusValue,
  type CapsuleBranchResourceStatus as CapsuleBranchResourceStatusValue,
} from '@qiln/core/server'
import { IncusError, readIncusErrorDetailCode } from '../../../../../errors'
import { InlineOperationStepExecutor } from '../../inlineStepExecutor'
import { createOperationFailureContext } from '../../errors'
import { CapsuleBranchDeleteStepKey } from './steps'
import type { CapsuleBranchEventPublisher } from '../../../branch/events'
import type {
  CapsuleBranchOperationStepStore,
  CapsuleBranchOperationStore,
  CapsuleBranchResourceStore,
  CapsuleBranchStore,
} from '../../../stores'
import type { CapsuleBranchDeletePlanner } from './planner'
import type { IncusClient } from '../../../../../incus/client/index'
import type { BranchDeletePlanSelection, BranchDeleteSagaInput, BranchDeleteVolumeTarget } from './types'

export type ResolveCapsuleOwnerNamespace = (ownerId: string) => string

export interface CapsuleBranchDeleteSagaStores {
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

/**
 * Inline durable branch delete operation.
 *
 * This saga does not recover or resume interrupted deletes. If execution fails while
 * active, it marks the branch/operation cleanup_required when completion cannot be
 * proven. Startup abandonment handling separately marks interrupted operations as
 * cleanup_required without replaying these steps.
 */
export class CapsuleBranchDeleteSaga {
  private readonly stepExecutor: InlineOperationStepExecutor

  constructor(
    private readonly stores: CapsuleBranchDeleteSagaStores,
    private readonly planner: CapsuleBranchDeletePlanner,
    private readonly incus: IncusClient,
    private readonly events: CapsuleBranchEventPublisher,
    private readonly resolveNamespace: ResolveCapsuleOwnerNamespace,
  ) {
    this.stepExecutor = new InlineOperationStepExecutor(this.stores.steps)
  }

  public async execute(input: BranchDeleteSagaInput): Promise<CapsuleBranchDeleteOutput> {
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

      const selection = await runStep(
        CapsuleBranchDeleteStepKey.PLAN_DELETE,
        {
          branchName: input.name,
        },
        async (): Promise<BranchDeletePlanSelection> => {
          const inventory = await this.stores.resources.listBranchResourceInventory(input.ownerId, input.name)
          if (inventory.length === 0) {
            console.warn(
              `[CapsuleBranchDeleteSaga] Branch '${input.name}' has no durable resource inventory. Falling back to live Incus discovery.`,
            )
            return {
              mode: 'live_discovery',
            }
          }

          return {
            mode: 'inventory',
            plan: this.planner.createPlan(inventory),
          }
        },
      )

      const project = this.incus.UseProject(namespace)

      if (selection.mode === 'inventory') {
        await runStep(
          CapsuleBranchDeleteStepKey.DELETE_INSTANCE,
          {
            branchName: input.name,
            resourceId: selection.plan.instance?.resourceId ?? null,
            instanceName: selection.plan.instance?.instanceName ?? input.name,
          },
          async () => {
            await this.deleteBranchInstance(
              project,
              accepted.operationId,
              selection.plan.instance?.resourceId ?? null,
              selection.plan.instance?.instanceName ?? input.name,
            )
          },
        )

        await runStep(
          CapsuleBranchDeleteStepKey.DELETE_VOLUMES,
          {
            count: selection.plan.volumes.length,
          },
          async () => {
            for (const volume of selection.plan.volumes) {
              await this.deleteBranchVolume(project, accepted.operationId, volume)
            }
          },
        )

        await runStep(
          CapsuleBranchDeleteStepKey.MARK_PROVISIONING_FILES_DELETED,
          {
            count: selection.plan.provisioningFileResourceIds.length,
          },
          async () => {
            for (const resourceId of selection.plan.provisioningFileResourceIds) {
              await this.transitionResourceStatusBestEffort(resourceId, accepted.operationId, CapsuleBranchResourceStatus.DELETED)
            }
          },
        )
      } else {
        await runStep(
          CapsuleBranchDeleteStepKey.DELETE_DISCOVERED_RESOURCES,
          {
            branchName: input.name,
          },
          async () => {
            await this.deleteUsingLiveIncusDiscovery(project, input.name)
          },
        )
      }

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
    resourceId: string | null,
    instanceName: string,
  ): Promise<void> {
    await this.transitionResourceStatusBestEffort(resourceId, operationId, CapsuleBranchResourceStatus.DELETING)

    let instanceMissing = false
    try {
      await project.instances.stop(instanceName)
    } catch (err: unknown) {
      const detailCode = err instanceof IncusError ? readIncusErrorDetailCode(err) : undefined
      if (err instanceof IncusError && err.code === 'NOT_FOUND') {
        instanceMissing = true
      } else if (!(err instanceof IncusError && detailCode === 400)) {
        await this.markResourceErrorBestEffort(resourceId, operationId, err, {
          action: 'stop_instance_before_delete',
          instanceName,
        })
        throw err
      }
    }

    if (instanceMissing) {
      await this.transitionResourceStatusBestEffort(resourceId, operationId, CapsuleBranchResourceStatus.MISSING)
      return
    }

    try {
      await project.instances.delete(instanceName)
      await this.transitionResourceStatusBestEffort(resourceId, operationId, CapsuleBranchResourceStatus.DELETED)
    } catch (err: unknown) {
      if (err instanceof IncusError && err.code === 'NOT_FOUND') {
        await this.transitionResourceStatusBestEffort(resourceId, operationId, CapsuleBranchResourceStatus.MISSING)
        return
      }

      await this.markResourceErrorBestEffort(resourceId, operationId, err, {
        action: 'delete_instance',
        instanceName,
      })
      throw err
    }
  }

  private async deleteBranchVolume(project: ScopedIncusProject, operationId: string, volume: BranchDeleteVolumeTarget): Promise<void> {
    await this.transitionResourceStatusBestEffort(volume.resourceId, operationId, CapsuleBranchResourceStatus.DELETING)

    try {
      await project.storage.delete(volume.pool, volume.volumeName)
      await this.transitionResourceStatusBestEffort(volume.resourceId, operationId, CapsuleBranchResourceStatus.DELETED)
    } catch (err: unknown) {
      if (err instanceof IncusError && err.code === 'NOT_FOUND') {
        await this.transitionResourceStatusBestEffort(volume.resourceId, operationId, CapsuleBranchResourceStatus.MISSING)
        return
      }

      await this.markResourceErrorBestEffort(volume.resourceId, operationId, err, {
        action: 'delete_volume',
        pool: volume.pool,
        volumeName: volume.volumeName,
      })
      throw err
    }
  }

  private async deleteUsingLiveIncusDiscovery(project: ScopedIncusProject, name: string): Promise<void> {
    const volumesToDelete: { pool: string; source: string }[] = []

    try {
      const { data } = await project.instances.get(name)
      if (data.devices) {
        for (const device of Object.values(data.devices)) {
          if (device.type === 'disk' && device.path !== '/' && typeof device.source === 'string' && typeof device.pool === 'string') {
            volumesToDelete.push({
              pool: device.pool,
              source: device.source,
            })
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof IncusError && err.code === 'NOT_FOUND') {
        throw new IncusError('Capsule branch container is missing on the host. Marked for admin review.', 'CONFLICT')
      }
      throw err
    }

    try {
      await project.instances.stop(name)
    } catch (err: unknown) {
      const detailCode = err instanceof IncusError ? readIncusErrorDetailCode(err) : undefined
      if (!(err instanceof IncusError && (err.code === 'NOT_FOUND' || detailCode === 400))) {
        throw err
      }
    }

    try {
      await project.instances.delete(name)
    } catch (err: unknown) {
      if (!(err instanceof IncusError && err.code === 'NOT_FOUND')) {
        throw err
      }
    }

    for (const volume of volumesToDelete) {
      try {
        await project.storage.delete(volume.pool, volume.source)
      } catch (err: unknown) {
        if (!(err instanceof IncusError && err.code === 'NOT_FOUND')) {
          throw err
        }
      }
    }
  }

  private async transitionResourceStatusBestEffort(
    resourceId: string | null,
    operationId: string,
    status: CapsuleBranchResourceStatusValue,
  ): Promise<void> {
    if (!resourceId) {
      return
    }

    try {
      await this.stores.resources.transitionBranchResourceStatusForOperation(resourceId, operationId, status)
    } catch (error: unknown) {
      console.error(`[CapsuleBranchDeleteSaga] Failed to mark resource '${resourceId}' as '${status}'.`, error)
    }
  }

  private async markResourceErrorBestEffort(
    resourceId: string | null,
    operationId: string,
    error: unknown,
    context?: Record<string, unknown>,
  ): Promise<void> {
    if (!resourceId) {
      return
    }

    try {
      await this.stores.resources.markBranchResourceErrorForOperation(resourceId, operationId, error, context)
    } catch (dbError: unknown) {
      console.error(`[CapsuleBranchDeleteSaga] Failed to persist resource error for '${resourceId}'.`, dbError)
    }
  }

  private async markBranchCleanupRequiredBestEffort(ownerId: string, branchName: string): Promise<void> {
    try {
      await this.stores.branches.transitionBranchState(ownerId, branchName, 'cleanup_required')
      this.events.publishStateChanged(ownerId, branchName, 'cleanup_required')
    } catch (error: unknown) {
      console.error(`[CapsuleBranchDeleteSaga] Failed to mark branch '${branchName}' cleanup_required.`, error)
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
      console.error(`[CapsuleBranchDeleteSaga] Failed to persist operation failure for '${operationId}'.`, dbError)
    }
  }
}
