import { IncusError } from '../../../../../errors'
import type { CapsuleRootfsImagePin } from '@qiln/core/server'
import type { CreateCapsuleExecutionState } from '../execution/state'
import type { CreateCapsuleOperationContext } from '../types'
import type {
  BranchResourceInput,
  CreateCapsuleBindMountResource,
  CreateCapsuleInstanceResource,
  CreateCapsulePlannedResource,
  CreateCapsuleProjectResource,
  CreateCapsuleProvisioningFileResource,
  CreateCapsuleVolumeResource,
} from '../../../resource/types'
import type { CapsuleResourceDriver } from '../../../resource/driver'
import type { CapsuleBranchResourceStore } from '../../../resource/store'

export interface CreateCapsuleProvisionerDependencies {
  resources: CapsuleBranchResourceStore
  driver: CapsuleResourceDriver
}

/**
 * Owns create-specific resource accounting around the injected provider driver.
 *
 * The executor retains ordering, step accounting, compensation eligibility, and
 * submission of failure evidence to classification. Missing planned rows are
 * errors; provisioning never inserts or repairs inventory.
 */
export class CreateCapsuleProvisioner {
  constructor(private readonly dependencies: CreateCapsuleProvisionerDependencies) {}

  public verifyRootfs(pin: CapsuleRootfsImagePin): Promise<void> {
    return this.dependencies.driver.verifyRootfs(pin)
  }

  /**
   * Namespace creation is idempotent at the provider boundary, but a failed
   * response cannot prove whether creation reached Incus. Projects remain
   * retained resources and never enter destructive compensation.
   */
  public async ensureNamespace(
    context: CreateCapsuleOperationContext,
    project: CreateCapsuleProjectResource,
    state: CreateCapsuleExecutionState,
  ): Promise<void> {
    const resource = this.identity(context, project)
    await this.dependencies.resources.begin(resource)
    try {
      await this.dependencies.driver.ensureNamespace(context.ownerId)
      await this.dependencies.resources.adopt(resource)
    } catch (error: unknown) {
      state.providerOwnershipUncertain = true
      await this.recordFailure(resource, state, 'ensure_namespace', error)
      throw error
    }
  }

  /**
   * Bind mounts are adopted external configuration. Recording their adoption
   * performs no provider mutation and creates no deletion obligation.
   */
  public async recordBindMounts(
    context: CreateCapsuleOperationContext,
    bindMounts: readonly CreateCapsuleBindMountResource[],
  ): Promise<void> {
    for (const bindMount of bindMounts) {
      await this.dependencies.resources.adopt(this.identity(context, bindMount))
    }
  }

  /**
   * A volume enters same-process compensation only after provider creation and
   * its durable successful outcome both complete.
   */
  public async createVolumes(
    context: CreateCapsuleOperationContext,
    volumes: readonly CreateCapsuleVolumeResource[],
    state: CreateCapsuleExecutionState,
  ): Promise<void> {
    for (const volume of volumes) {
      const resource = this.identity(context, volume)
      const resourceId = await this.dependencies.resources.begin(resource)
      try {
        await this.dependencies.driver.createVolume(context.namespace, volume)
        await this.dependencies.resources.created(resource)
        state.compensation.recordCreatedVolume(resourceId, resource, volume)
      } catch (error: unknown) {
        state.providerOwnershipUncertain = true
        await this.recordFailure(resource, state, 'create_volume', error)
        throw error
      }
    }
  }

  /**
   * The instance enters compensation only after its successful provider
   * creation has also been durably recorded.
   */
  public async createInstance(
    context: CreateCapsuleOperationContext,
    instance: CreateCapsuleInstanceResource,
    state: CreateCapsuleExecutionState,
  ): Promise<void> {
    const resource = this.identity(context, instance)
    const resourceId = await this.dependencies.resources.begin(resource)
    try {
      await this.dependencies.driver.createInstance(context.namespace, instance)
      await this.dependencies.resources.created(resource)
      state.compensation.recordCreatedInstance(resourceId, resource, instance.instanceName)
    } catch (error: unknown) {
      state.providerOwnershipUncertain = true
      await this.recordFailure(resource, state, 'create_instance', error)
      throw error
    }
  }

  /**
   * Provisioning files are derived resources. Their compensation eligibility is
   * tied to a proven backing resource rather than independent provider deletion.
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
      const resource = this.identity(context, file)
      const backingResourceId = this.backingResourceId(file, instanceResourceId, state)
      const resourceId = await this.dependencies.resources.begin(resource)
      state.compensation.recordDerivedProvisioningFile({
        resourceId,
        resourceKey: file.resourceKey,
        backingResourceId,
        resource,
      })
      try {
        await this.dependencies.driver.writeProvisioningFile(context.namespace, instanceName, file)
        await this.dependencies.resources.created(resource)
      } catch (error: unknown) {
        await this.recordFailure(resource, state, 'write_provisioning_file', error)
        throw error
      }
    }
  }

  private identity(
    context: CreateCapsuleOperationContext,
    resource: CreateCapsulePlannedResource,
  ): BranchResourceInput {
    return {
      operationId: context.operationId,
      capsuleId: context.capsuleId,
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

  private async recordFailure(
    resource: BranchResourceInput,
    state: CreateCapsuleExecutionState,
    action: string,
    error: unknown,
  ): Promise<void> {
    try {
      await this.dependencies.resources.failed(resource, error, {
        operationId: resource.operationId,
        capsuleId: resource.capsuleId,
        branchId: resource.branchId,
        resourceKey: resource.resourceKey,
        phase: state.phase,
        action,
        providerIntentConfirmed: state.providerIntentConfirmed,
        providerOwnershipUncertain: state.providerOwnershipUncertain,
      })
    } catch (persistenceError: unknown) {
      console.error(
        `[CreateCapsuleProvisioner] Failed to persist resource failure for '${resource.resourceKey}'.`,
        persistenceError,
      )
    }
  }
}
