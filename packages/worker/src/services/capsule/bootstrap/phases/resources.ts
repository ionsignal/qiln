import { createBootstrapOperationFailureContext } from '../failureContext'
import { BootstrapStepKey } from '../stepKeys'
import type { BootstrapExecutionState } from '../executionState'
import type {
  BootstrapBindMountResource,
  BootstrapInstanceResource,
  BootstrapOperationContext,
  BootstrapProjectResource,
  BootstrapVolumeResource,
} from '../types'
import type { CapsuleResourceDriver } from '../../resources/driver'
import type { BranchResourceInput, CapsuleBranchResourceStore } from '../../stores'

export interface BootstrapResourceMutationPhaseDependencies {
  resources: CapsuleBranchResourceStore
  driver: CapsuleResourceDriver
}

/**
 * Performs explicit namespace, bind-mount, volume, and instance mutations.
 *
 * Volume and instance creation remain separate provider paths because both can introduce ownership uncertainty.
 * This phase records facts in execution state but never chooses terminal capsule or operation state.
 */
export class BootstrapResourceMutationPhase {
  constructor(private readonly dependencies: BootstrapResourceMutationPhaseDependencies) {}

  public async ensureNamespace(context: BootstrapOperationContext, project: BootstrapProjectResource): Promise<void> {
    const resourceId = await this.dependencies.resources.ensureBranchResource(this.withLifecycleOperationContext(context, project))
    try {
      await this.dependencies.driver.ensureNamespace(context.ownerId)
      await this.dependencies.resources.recordBranchResourceAdoption(resourceId, context.operationId)
    } catch (error: unknown) {
      await this.markResourceErrorBestEffort(
        resourceId,
        error,
        createBootstrapOperationFailureContext({
          operationId: context.operationId,
          capsuleId: context.capsuleId,
          branchId: context.branchId,
          branchName: context.branchName,
          phase: BootstrapStepKey.ENSURE_NAMESPACE,
          stepKey: BootstrapStepKey.ENSURE_NAMESPACE,
          action: 'ensure_namespace_dependency',
          resourceId,
          resourceKey: project.resourceKey,
        }),
      )
      throw error
    }
  }

  public async recordBindMounts(context: BootstrapOperationContext, bindMounts: readonly BootstrapBindMountResource[]): Promise<void> {
    for (const bindMount of bindMounts) {
      const resourceId = await this.dependencies.resources.ensureBranchResource(this.withLifecycleOperationContext(context, bindMount))
      await this.dependencies.resources.recordBranchResourceAdoption(resourceId, context.operationId)
    }
  }

  public async createVolumes(
    context: BootstrapOperationContext,
    volumes: readonly BootstrapVolumeResource[],
    state: BootstrapExecutionState,
  ): Promise<void> {
    for (const volume of volumes) {
      const resourceId = await this.dependencies.resources.ensureBranchResource(this.withLifecycleOperationContext(context, volume))
      let providerMutationStarted = false
      try {
        await this.dependencies.resources.recordBranchResourceCreateIntent(resourceId, context.operationId)
        providerMutationStarted = true
        await this.dependencies.driver.createVolume(context.namespace, volume)
        await this.dependencies.resources.recordBranchResourceCreateOutcome(resourceId, context.operationId)
        state.compensation.recordCreatedVolume(resourceId, volume)
      } catch (error: unknown) {
        if (providerMutationStarted) {
          state.markProviderOwnershipUncertain()
          await this.dependencies.resources.recordBranchResourceCreateFailure(
            resourceId,
            context.operationId,
            error,
            createBootstrapOperationFailureContext({
              operationId: context.operationId,
              capsuleId: context.capsuleId,
              branchId: context.branchId,
              branchName: context.branchName,
              phase: BootstrapStepKey.CREATE_VOLUMES,
              stepKey: BootstrapStepKey.CREATE_VOLUMES,
              action: 'create_volume',
              resourceId,
              resourceKey: volume.resourceKey,
            }),
          )
        }
        throw error
      }
    }
  }

  public async createInstance(
    context: BootstrapOperationContext,
    instance: BootstrapInstanceResource,
    state: BootstrapExecutionState,
  ): Promise<void> {
    const resourceId = await this.dependencies.resources.ensureBranchResource(this.withLifecycleOperationContext(context, instance))
    let providerMutationStarted = false
    try {
      await this.dependencies.resources.recordBranchResourceCreateIntent(resourceId, context.operationId)
      providerMutationStarted = true
      await this.dependencies.driver.createInstance(context.namespace, instance)
      await this.dependencies.resources.recordBranchResourceCreateOutcome(resourceId, context.operationId)
      state.compensation.recordCreatedInstance(resourceId, instance.resourceKey, instance.instanceName)
    } catch (error: unknown) {
      if (providerMutationStarted) {
        state.markProviderOwnershipUncertain()
        await this.dependencies.resources.recordBranchResourceCreateFailure(
          resourceId,
          context.operationId,
          error,
          createBootstrapOperationFailureContext({
            operationId: context.operationId,
            capsuleId: context.capsuleId,
            branchId: context.branchId,
            branchName: context.branchName,
            phase: BootstrapStepKey.CREATE_INSTANCE,
            stepKey: BootstrapStepKey.CREATE_INSTANCE,
            action: 'create_instance',
            resourceId,
            resourceKey: instance.resourceKey,
          }),
        )
      }
      throw error
    }
  }

  private withLifecycleOperationContext(
    context: BootstrapOperationContext,
    resource: {
      resourceType: BranchResourceInput['resourceType']
      resourceKey: string
      cleanupPolicy: BranchResourceInput['cleanupPolicy']
      metadata?: Record<string, unknown>
    },
  ): BranchResourceInput {
    return {
      ownerId: context.ownerId,
      branchId: context.branchId,
      lifecycleOperationId: context.operationId,
      branchName: context.branchName,
      resourceType: resource.resourceType,
      resourceKey: resource.resourceKey,
      cleanupPolicy: resource.cleanupPolicy,
      metadata: resource.metadata,
    }
  }

  private async markResourceErrorBestEffort(resourceId: string, error: unknown, failureContext: Record<string, unknown>): Promise<void> {
    try {
      await this.dependencies.resources.markBranchResourceError(resourceId, error, failureContext)
    } catch (databaseError: unknown) {
      console.error(`[BootstrapResourceMutationPhase] Failed to persist resource error for '${resourceId}'.`, databaseError)
    }
  }
}
