import { IncusError } from '../../../../../errors'
import type { CapsuleRootfsImagePin } from '@qiln/core/server'
import type { CreateCapsuleExecutionState } from '../execution/state'
import type {
  CreateCapsuleBindMountResource,
  CreateCapsuleInstanceResource,
  CreateCapsuleOperationContext,
  CreateCapsulePlannedResource,
  CreateCapsuleProjectResource,
  CreateCapsuleProvisioningFileResource,
  CreateCapsuleVolumeResource,
} from '../types'
import type { CapsuleResourceDriver } from '../../../resource/driver'
import type { CapsuleBranchResourceStore } from '../../../resource/store'
import type { BranchResourceInput } from '../../../resource/types'

export interface CreateCapsuleProvisionerDependencies {
  resources: CapsuleBranchResourceStore
  driver: CapsuleResourceDriver
}

interface CreateResourceFailureInput {
  context: CreateCapsuleOperationContext
  state: CreateCapsuleExecutionState
  resourceId: string
  resourceKey: string
  action: 'create_volume' | 'create_instance' | 'write_provisioning_file'
  error: unknown
}

/**
 * Owns create-specific resource accounting around the injected provider driver.
 *
 * The executor retains ordering, step accounting, compensation eligibility, and
 * submission of failure evidence to classification.
 */
export class CreateCapsuleProvisioner {
  constructor(private readonly dependencies: CreateCapsuleProvisionerDependencies) {}

  public verifyRootfs(pin: CapsuleRootfsImagePin): Promise<void> {
    return this.dependencies.driver.verifyRootfs(pin)
  }

  /**
   * Ensures the owner-scoped provider namespace and records that the namespace
   * is an adopted, retained resource.
   *
   * Namespace creation is idempotent at the provider boundary, but a failed
   * provider response cannot prove whether creation reached Incus. That outcome
   * therefore makes provider ownership uncertain for this create attempt.
   */
  public async ensureNamespace(
    context: CreateCapsuleOperationContext,
    project: CreateCapsuleProjectResource,
    state: CreateCapsuleExecutionState,
  ): Promise<void> {
    const resourceId = await this.dependencies.resources.ensureBranchResource(this.resourceInput(context, project))
    try {
      await this.dependencies.driver.ensureNamespace(context.ownerId)
      await this.dependencies.resources.recordBranchResourceAdoption(resourceId, context.operationId)
    } catch (error: unknown) {
      state.providerOwnershipUncertain = true
      try {
        await this.dependencies.resources.markBranchResourceError(resourceId, error, {
          ...context,
          phase: state.phase,
          action: 'ensure_namespace',
          resourceId,
          resourceKey: project.resourceKey,
          providerIntentConfirmed: state.providerIntentConfirmed,
          providerOwnershipUncertain: state.providerOwnershipUncertain,
        })
      } catch (persistenceError: unknown) {
        console.error(
          `[CreateCapsuleProvisioner] Failed to persist resource error for '${resourceId}'.`,
          persistenceError,
        )
      }
      throw error
    }
  }

  /**
   * Records external bind mounts in the durable branch resource inventory.
   *
   * Bind mounts are adopted external resources. Qiln records their identity for
   * audit and complete inventory verification but never treats them as direct
   * provider resources eligible for create compensation or branch deletion.
   */
  public async recordBindMounts(
    context: CreateCapsuleOperationContext,
    bindMounts: readonly CreateCapsuleBindMountResource[],
  ): Promise<void> {
    for (const bindMount of bindMounts) {
      const resourceId = await this.dependencies.resources.ensureBranchResource(this.resourceInput(context, bindMount))
      await this.dependencies.resources.recordBranchResourceAdoption(resourceId, context.operationId)
    }
  }

  /**
   * Creates every managed branch volume in deterministic plan order.
   *
   * Each provider call is fenced by a per-resource create-intent transition. A
   * volume enters the process-local compensation scope only after both provider
   * creation and its durable create outcome have completed successfully.
   */
  public async createVolumes(
    context: CreateCapsuleOperationContext,
    volumes: readonly CreateCapsuleVolumeResource[],
    state: CreateCapsuleExecutionState,
  ): Promise<void> {
    for (const volume of volumes) {
      const resourceId = await this.dependencies.resources.ensureBranchResource(this.resourceInput(context, volume))
      let providerMutationAttempted = false
      try {
        await this.dependencies.resources.recordBranchResourceCreateIntent(resourceId, context.operationId)
        providerMutationAttempted = true
        await this.dependencies.driver.createVolume(context.namespace, volume)
        await this.dependencies.resources.recordBranchResourceCreateOutcome(resourceId, context.operationId)
        state.compensation.recordCreatedVolume(resourceId, volume)
      } catch (error: unknown) {
        if (providerMutationAttempted) {
          state.providerOwnershipUncertain = true
          await this.recordCreateFailure({
            context,
            state,
            resourceId,
            resourceKey: volume.resourceKey,
            action: 'create_volume',
            error,
          })
        }
        throw error
      }
    }
  }

  /**
   * Creates the root branch instance after all managed volumes have been
   * created.
   *
   * The instance enters the compensation scope only after its successful
   * provider creation has also been durably recorded.
   */
  public async createInstance(
    context: CreateCapsuleOperationContext,
    instance: CreateCapsuleInstanceResource,
    state: CreateCapsuleExecutionState,
  ): Promise<void> {
    const resourceId = await this.dependencies.resources.ensureBranchResource(this.resourceInput(context, instance))
    let providerMutationAttempted = false
    try {
      await this.dependencies.resources.recordBranchResourceCreateIntent(resourceId, context.operationId)
      providerMutationAttempted = true
      await this.dependencies.driver.createInstance(context.namespace, instance)
      await this.dependencies.resources.recordBranchResourceCreateOutcome(resourceId, context.operationId)
      state.compensation.recordCreatedInstance(resourceId, instance.resourceKey, instance.instanceName)
    } catch (error: unknown) {
      if (providerMutationAttempted) {
        state.providerOwnershipUncertain = true

        await this.recordCreateFailure({
          context,
          state,
          resourceId,
          resourceKey: instance.resourceKey,
          action: 'create_instance',
          error,
        })
      }
      throw error
    }
  }

  /**
   * Writes planned provisioning files after the instance and all managed
   * volumes have been created and durably recorded.
   *
   * Provisioning files are derived resources. Their compensation eligibility is
   * tied to a proven direct backing resource rather than to independent
   * provider deletion.
   */
  public async writeFiles(
    context: CreateCapsuleOperationContext,
    instanceName: string,
    files: readonly CreateCapsuleProvisioningFileResource[],
    state: CreateCapsuleExecutionState,
  ): Promise<void> {
    const instanceResourceId = state.compensation.getCreatedInstanceResourceId()
    if (!instanceResourceId) {
      throw new IncusError(
        'Capsule root instance ownership was not durably recorded before provisioning files.',
        'API_ERROR',
        {
          operationId: context.operationId,
          capsuleId: context.capsuleId,
          rootBranchId: context.rootBranchId,
        },
      )
    }
    for (const file of files) {
      const resourceId = await this.dependencies.resources.ensureBranchResource(this.resourceInput(context, file))
      const backingResourceId = this.backingResourceId(file, instanceResourceId, state)
      state.compensation.recordDerivedProvisioningFile({
        resourceId,
        resourceKey: file.resourceKey,
        backingResourceId,
      })
      let providerMutationAttempted = false
      try {
        await this.dependencies.resources.recordBranchResourceCreateIntent(resourceId, context.operationId)
        providerMutationAttempted = true
        await this.dependencies.driver.writeProvisioningFile(context.namespace, instanceName, file)
        await this.dependencies.resources.recordBranchResourceCreateOutcome(resourceId, context.operationId)
      } catch (error: unknown) {
        if (providerMutationAttempted) {
          await this.recordCreateFailure({
            context,
            state,
            resourceId,
            resourceKey: file.resourceKey,
            action: 'write_provisioning_file',
            error,
          })
        }
        throw error
      }
    }
  }

  private resourceInput(
    context: CreateCapsuleOperationContext,
    resource: CreateCapsulePlannedResource,
  ): BranchResourceInput {
    return {
      operationId: context.operationId,
      ownerId: context.ownerId,
      branchId: context.rootBranchId,
      branchName: context.rootBranchName,
      resourceType: resource.resourceType,
      resourceKey: resource.resourceKey,
      blueprintVolumeName: resource.blueprintVolumeName,
      cleanupPolicy: resource.cleanupPolicy,
      metadata: resource.metadata,
    }
  }

  private backingResourceId(
    file: CreateCapsuleProvisioningFileResource,
    instanceResourceId: string,
    state: CreateCapsuleExecutionState,
  ): string {
    if (file.target.target === 'instance') {
      return instanceResourceId
    }
    const resourceId = state.compensation.getCreatedVolumeResourceId(file.target.pool, file.target.volumeName)
    if (!resourceId) {
      throw new IncusError(
        'Provisioning file targets a managed volume without durable ownership proof.',
        'VALIDATION_ERROR',
        {
          resourceKey: file.resourceKey,
          pool: file.target.pool,
          volumeName: file.target.volumeName,
        },
      )
    }
    return resourceId
  }

  private async recordCreateFailure(input: CreateResourceFailureInput): Promise<void> {
    try {
      await this.dependencies.resources.recordBranchResourceCreateFailure(
        input.resourceId,
        input.context.operationId,
        input.error,
        {
          ...input.context,
          phase: input.state.phase,
          action: input.action,
          resourceId: input.resourceId,
          resourceKey: input.resourceKey,
          providerIntentConfirmed: input.state.providerIntentConfirmed,
          providerOwnershipUncertain: input.state.providerOwnershipUncertain,
        },
      )
    } catch (persistenceError: unknown) {
      console.error(
        `[CreateCapsuleProvisioner] Failed to persist create failure for resource '${input.resourceId}'.`,
        persistenceError,
      )
    }
  }
}
