import { CapsuleBranchResourceStatus } from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import {
  DestroyOperationPhase,
  buildDestroyFailureDiagnostics,
  createDestroyCapsuleProviderFailure,
} from '../execution/diagnostics'
import type { IncusClient } from '../../../../../incus/client/index'
import type { CapsuleBranchResourceStore } from '../../../resource/store'
import type {
  DestroyCapsuleInstanceTarget,
  DestroyCapsuleOperationContext,
  DestroyCapsulePlan,
  DestroyCapsuleProvisioningFileResource,
  DestroyCapsuleVolumeTarget,
} from '../types'

export interface DestroyCapsuleProviderDependencies {
  incus: IncusClient
  resources: CapsuleBranchResourceStore
}

/**
 * Deletes only provider resources selected by a proven durable destroy plan.
 *
 * Operation-wide provider intent must already be committed before any method
 * that can stop or delete a provider resource is invoked.
 */
export class DestroyCapsuleProvider {
  constructor(private readonly dependencies: DestroyCapsuleProviderDependencies) {}

  public async deleteInstances(
    context: DestroyCapsuleOperationContext,
    targets: readonly DestroyCapsuleInstanceTarget[],
  ): Promise<void> {
    for (const target of targets) {
      await this.deleteInstance(context, target)
    }
  }

  public async deleteVolumes(
    context: DestroyCapsuleOperationContext,
    targets: readonly DestroyCapsuleVolumeTarget[],
  ): Promise<void> {
    for (const target of targets) {
      await this.deleteVolume(context, target)
    }
  }

  public async finalizeDerivedResources(
    context: DestroyCapsuleOperationContext,
    plan: DestroyCapsulePlan,
  ): Promise<void> {
    const rows = await this.dependencies.resources.listBranchResourceInventories(
      plan.branches.map(branchPlan => branchPlan.branch.id),
    )
    const rowsById = new Map(rows.map(row => [row.id, row]))
    for (const file of plan.provisioningFiles) {
      this.assertBackingResourceTerminal(file, rowsById)
      await this.dependencies.resources.recordDestroyDerivedResourceDeletion(file.id, context.operationId)
    }
  }

  private async deleteInstance(
    context: DestroyCapsuleOperationContext,
    target: DestroyCapsuleInstanceTarget,
  ): Promise<void> {
    await this.dependencies.resources.recordBranchResourceDeleteIntent(target.id, context.operationId)
    const project = this.dependencies.incus.project(target.namespace)
    try {
      let providerState: string
      try {
        const state = await project.instances.state(target.instanceName)
        providerState = state.data.status
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
      if (providerState === 'Running') {
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
      } else if (providerState !== 'Stopped') {
        throw new IncusError(
          'Managed capsule instance is in an unsupported state for fail-closed deletion.',
          'CONFLICT',
          {
            capsuleId: context.capsuleId,
            branchId: target.branchId,
            branchName: target.branchName,
            resourceId: target.id,
            resourceKey: target.resourceKey,
            namespace: target.namespace,
            instanceName: target.instanceName,
            providerState,
          },
        )
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

      await this.dependencies.resources.recordBranchResourceDeleteOutcome(
        target.id,
        context.operationId,
        CapsuleBranchResourceStatus.DELETED,
      )
    } catch (error: unknown) {
      await this.recordDeleteFailureBestEffort(
        context,
        target,
        DestroyOperationPhase.DELETE_BRANCH_INSTANCES,
        'delete_capsule_branch_instance',
        error,
      )
      throw error
    }
  }

  private async deleteVolume(
    context: DestroyCapsuleOperationContext,
    target: DestroyCapsuleVolumeTarget,
  ): Promise<void> {
    await this.dependencies.resources.recordBranchResourceDeleteIntent(target.id, context.operationId)
    const project = this.dependencies.incus.project(target.namespace)
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
      await this.dependencies.resources.recordBranchResourceDeleteOutcome(
        target.id,
        context.operationId,
        CapsuleBranchResourceStatus.DELETED,
      )
    } catch (error: unknown) {
      await this.recordDeleteFailureBestEffort(
        context,
        target,
        DestroyOperationPhase.DELETE_BRANCH_VOLUMES,
        'delete_capsule_branch_volume',
        error,
      )
      throw error
    }
  }

  private assertBackingResourceTerminal(
    file: DestroyCapsuleProvisioningFileResource,
    rowsById: ReadonlyMap<string, { status: string }>,
  ): void {
    const backing = rowsById.get(file.backingResourceId)
    if (
      !backing ||
      (backing.status !== CapsuleBranchResourceStatus.DELETED && backing.status !== CapsuleBranchResourceStatus.MISSING)
    ) {
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
    context: DestroyCapsuleOperationContext,
    target: DestroyCapsuleInstanceTarget | DestroyCapsuleVolumeTarget,
    phase: typeof DestroyOperationPhase.DELETE_BRANCH_INSTANCES | typeof DestroyOperationPhase.DELETE_BRANCH_VOLUMES,
    action: string,
    error: unknown,
  ): Promise<void> {
    const providerFailure = createDestroyCapsuleProviderFailure({
      phase,
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
        buildDestroyFailureDiagnostics({
          operationId: context.operationId,
          capsuleId: context.capsuleId,
          phase,
          failedPhase: phase,
          stepKey: phase,
          action,
          branchId: target.branchId,
          branchName: target.branchName,
          resourceId: target.id,
          resourceKey: target.resourceKey,
          providerIntentCommitted: true,
          providerOwnershipUncertain: true,
          aggregateCompletionCommitted: false,
          branchCount: context.branches.length,
        }),
      )
    } catch (persistenceError: unknown) {
      console.error(
        `[DestroyCapsuleProvider] Failed to persist provider deletion failure for resource '${target.id}'.`,
        {
          providerFailure,
          persistenceError,
        },
      )
    }
  }

  private isNotFound(error: unknown): boolean {
    return error instanceof IncusError && error.code === 'NOT_FOUND'
  }
}
