import { CapsuleBranchResourceStatus } from '@qiln/core/server'
import { IncusError } from '../../../../errors'
import {
  CapsuleDestroyFailurePhase,
  createCapsuleDestroyOperationFailureContext,
  createCapsuleDestroyProviderFailureDetail,
} from './failureContext'
import type { IncusClient } from '../../../../incus/client/index'
import type { CapsuleBranchResourceStore } from '../../stores'
import type {
  CapsuleDestroyContext,
  CapsuleDestroyInstanceTarget,
  CapsuleDestroyPlan,
  CapsuleDestroyProvisioningFileResource,
  CapsuleDestroyVolumeTarget,
} from './types'

export interface CapsuleDestroyProviderPhaseDependencies {
  incus: IncusClient
  resources: CapsuleBranchResourceStore
}

/**
 * Deletes only direct provider resources selected by the proven destroy plan.
 *
 * Every provider mutation is fenced by durable intent and terminal outcome writes.
 * This phase does not discover ownership, compensate, retry, or resume.
 */
export class CapsuleDestroyProviderPhase {
  constructor(private readonly dependencies: CapsuleDestroyProviderPhaseDependencies) {}

  public async deleteInstances(context: CapsuleDestroyContext, targets: readonly CapsuleDestroyInstanceTarget[]): Promise<void> {
    for (const target of targets) {
      await this.deleteInstance(context, target)
    }
  }

  public async deleteVolumes(context: CapsuleDestroyContext, targets: readonly CapsuleDestroyVolumeTarget[]): Promise<void> {
    for (const target of targets) {
      await this.deleteVolume(context, target)
    }
  }

  public async finalizeDerivedResources(context: CapsuleDestroyContext, plan: CapsuleDestroyPlan): Promise<void> {
    const rows = await this.dependencies.resources.listBranchResourceInventories(plan.branches.map(branchPlan => branchPlan.branch.id))
    const rowsById = new Map(rows.map(row => [row.id, row]))
    for (const file of plan.provisioningFiles) {
      this.assertBackingResourceTerminal(file, rowsById)
      await this.dependencies.resources.recordDestroyDerivedResourceDeletion(file.id, context.operationId)
    }
  }

  private async deleteInstance(context: CapsuleDestroyContext, target: CapsuleDestroyInstanceTarget): Promise<void> {
    await this.dependencies.resources.recordBranchResourceDeleteIntent(target.id, context.operationId)
    const project = this.dependencies.incus.UseProject(target.namespace)
    try {
      let state: string
      try {
        const result = await project.instances.state(target.instanceName)
        state = result.data.status
      } catch (error: unknown) {
        if (this.isNotFound(error)) {
          await this.dependencies.resources.recordBranchResourceDeleteOutcome(
            target.id,
            context.operationId,
            CapsuleBranchResourceStatus.MISSING,
          )
          return
        }
        throw error
      }
      if (state === 'Running') {
        try {
          await project.instances.stop(target.instanceName)
        } catch (error: unknown) {
          if (this.isNotFound(error)) {
            await this.dependencies.resources.recordBranchResourceDeleteOutcome(
              target.id,
              context.operationId,
              CapsuleBranchResourceStatus.MISSING,
            )
            return
          }
          throw error
        }
      } else if (state !== 'Stopped') {
        throw new IncusError('Managed capsule instance is in an unsupported state for fail-closed deletion.', 'CONFLICT', {
          capsuleId: context.capsuleId,
          branchId: target.branchId,
          branchName: target.branchName,
          resourceId: target.id,
          resourceKey: target.resourceKey,
          namespace: target.namespace,
          instanceName: target.instanceName,
          providerState: state,
        })
      }
      try {
        await project.instances.delete(target.instanceName)
      } catch (error: unknown) {
        if (this.isNotFound(error)) {
          await this.dependencies.resources.recordBranchResourceDeleteOutcome(
            target.id,
            context.operationId,
            CapsuleBranchResourceStatus.MISSING,
          )
          return
        }
        throw error
      }
      await this.dependencies.resources.recordBranchResourceDeleteOutcome(target.id, context.operationId, CapsuleBranchResourceStatus.DELETED)
    } catch (error: unknown) {
      await this.recordDeleteFailureBestEffort(
        context,
        target,
        CapsuleDestroyFailurePhase.DELETE_BRANCH_INSTANCES,
        'delete_capsule_branch_instance',
        error,
      )
      throw error
    }
  }

  private async deleteVolume(context: CapsuleDestroyContext, target: CapsuleDestroyVolumeTarget): Promise<void> {
    await this.dependencies.resources.recordBranchResourceDeleteIntent(target.id, context.operationId)
    const project = this.dependencies.incus.UseProject(target.namespace)
    try {
      try {
        await project.storage.delete(target.pool, target.volumeName)
      } catch (error: unknown) {
        if (this.isNotFound(error)) {
          await this.dependencies.resources.recordBranchResourceDeleteOutcome(
            target.id,
            context.operationId,
            CapsuleBranchResourceStatus.MISSING,
          )
          return
        }
        throw error
      }
      await this.dependencies.resources.recordBranchResourceDeleteOutcome(target.id, context.operationId, CapsuleBranchResourceStatus.DELETED)
    } catch (error: unknown) {
      await this.recordDeleteFailureBestEffort(
        context,
        target,
        CapsuleDestroyFailurePhase.DELETE_BRANCH_VOLUMES,
        'delete_capsule_branch_volume',
        error,
      )
      throw error
    }
  }

  private assertBackingResourceTerminal(file: CapsuleDestroyProvisioningFileResource, rowsById: ReadonlyMap<string, { status: string }>): void {
    const backing = rowsById.get(file.backingResourceId)
    if (!backing || (backing.status !== CapsuleBranchResourceStatus.DELETED && backing.status !== CapsuleBranchResourceStatus.MISSING)) {
      throw new IncusError('Provisioning-file backing resource has no terminal destroy outcome.', 'CONFLICT', {
        branchId: file.branchId,
        branchName: file.branchName,
        resourceId: file.id,
        resourceKey: file.resourceKey,
        backingResourceId: file.backingResourceId,
        backingResourceStatus: backing?.status ?? null,
      })
    }
  }

  private async recordDeleteFailureBestEffort(
    context: CapsuleDestroyContext,
    target: CapsuleDestroyInstanceTarget | CapsuleDestroyVolumeTarget,
    phase: typeof CapsuleDestroyFailurePhase.DELETE_BRANCH_INSTANCES | typeof CapsuleDestroyFailurePhase.DELETE_BRANCH_VOLUMES,
    action: string,
    error: unknown,
  ): Promise<void> {
    const providerFailure = createCapsuleDestroyProviderFailureDetail(phase, {
      action,
      error,
      branchId: target.branchId,
      branchName: target.branchName,
      resourceId: target.id,
      resourceKey: target.resourceKey,
    })
    try {
      await this.dependencies.resources.recordBranchResourceDeleteFailure(
        target.id,
        context.operationId,
        error,
        createCapsuleDestroyOperationFailureContext({
          operationId: context.operationId,
          capsuleId: context.capsuleId,
          branchId: target.branchId,
          branchName: target.branchName,
          phase,
          action,
          resourceId: target.id,
          resourceKey: target.resourceKey,
          resourceOwnershipUncertain: true,
          aggregateDestroyed: false,
          branchCount: context.branches.length,
        }),
      )
    } catch (persistenceError: unknown) {
      console.error(`[CapsuleDestroyProviderPhase] Failed to persist provider deletion failure for resource '${target.id}'.`, {
        providerFailure,
        persistenceError,
      })
    }
  }

  private isNotFound(error: unknown): boolean {
    return error instanceof IncusError && error.code === 'NOT_FOUND'
  }
}
