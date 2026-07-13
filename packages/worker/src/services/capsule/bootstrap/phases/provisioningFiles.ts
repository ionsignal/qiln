import { IncusError } from '../../../../errors'
import { createBootstrapOperationFailureContext } from '../failureContext'
import { BootstrapStepKey } from '../stepKeys'
import type { CapsuleResourceDriver } from '../../resources/driver'
import type { BranchResourceInput, CapsuleBranchResourceStore } from '../../stores'
import type { BootstrapExecutionState } from '../executionState'
import type { BootstrapOperationContext, BootstrapProvisioningFileResource } from '../types'

export interface BootstrapProvisioningFilePhaseDependencies {
  resources: CapsuleBranchResourceStore
  driver: CapsuleResourceDriver
}

/**
 * Writes planned provisioning files and records their relationship to a proven backing instance or managed volume.
 *
 * Provisioning files remain derived resources. Their compensation is finalized only after the backing direct
 * resource has a durable terminal deletion outcome; this phase never schedules independent file deletion.
 */
export class BootstrapProvisioningFilePhase {
  constructor(private readonly dependencies: BootstrapProvisioningFilePhaseDependencies) {}

  public async writeFiles(
    context: BootstrapOperationContext,
    files: readonly BootstrapProvisioningFileResource[],
    state: BootstrapExecutionState,
  ): Promise<void> {
    const instanceResourceId = state.compensation.getCreatedInstanceResourceId()
    if (!instanceResourceId) {
      throw new IncusError('Capsule bootstrap instance ownership was not durably recorded before provisioning files.', 'API_ERROR', {
        operationId: context.operationId,
        capsuleId: context.capsuleId,
        branchName: context.branchName,
      })
    }
    for (const file of files) {
      const resourceId = await this.dependencies.resources.ensureBranchResource(this.withLifecycleOperationContext(context, file))
      const backingResourceId = this.resolveBackingResourceId(file, instanceResourceId, state)
      state.compensation.recordDerivedProvisioningFile({
        resourceId,
        resourceKey: file.resourceKey,
        backingResourceId,
      })
      let providerMutationStarted = false
      try {
        await this.dependencies.resources.recordBranchResourceCreateIntent(resourceId, context.operationId)
        providerMutationStarted = true
        await this.dependencies.driver.writeProvisioningFile(context.namespace, context.branchName, file)
        await this.dependencies.resources.recordBranchResourceCreateOutcome(resourceId, context.operationId)
      } catch (error: unknown) {
        if (providerMutationStarted) {
          await this.dependencies.resources.recordBranchResourceCreateFailure(
            resourceId,
            context.operationId,
            error,
            createBootstrapOperationFailureContext({
              operationId: context.operationId,
              capsuleId: context.capsuleId,
              branchId: context.branchId,
              branchName: context.branchName,
              phase: BootstrapStepKey.WRITE_PROVISIONING_FILES,
              stepKey: BootstrapStepKey.WRITE_PROVISIONING_FILES,
              action: 'write_provisioning_file',
              resourceId,
              resourceKey: file.resourceKey,
            }),
          )
        }
        throw error
      }
    }
  }

  private resolveBackingResourceId(
    file: BootstrapProvisioningFileResource,
    instanceResourceId: string,
    state: BootstrapExecutionState,
  ): string {
    if (file.target.target === 'instance') {
      return instanceResourceId
    }
    const backingResourceId = state.compensation.getCreatedVolumeResourceId(file.target.pool, file.target.volumeName)
    if (!backingResourceId) {
      throw new IncusError('Bootstrap provisioning file targets a managed volume without durable ownership proof.', 'VALIDATION_ERROR', {
        resourceKey: file.resourceKey,
        pool: file.target.pool,
        volumeName: file.target.volumeName,
      })
    }
    return backingResourceId
  }

  private withLifecycleOperationContext(context: BootstrapOperationContext, file: BootstrapProvisioningFileResource): BranchResourceInput {
    return {
      ownerId: context.ownerId,
      lifecycleOperationId: context.operationId,
      branchId: context.branchId,
      branchName: context.branchName,
      resourceType: file.resourceType,
      resourceKey: file.resourceKey,
      cleanupPolicy: file.cleanupPolicy,
      metadata: file.metadata,
    }
  }
}
