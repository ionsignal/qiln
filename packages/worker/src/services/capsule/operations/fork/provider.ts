import { IncusError } from '../../../../errors'
import type { IncusClient } from '../../../../incus/client'
import type { ProjectService } from '../../../project'
import type { CapsuleBranchResourceStore } from '../../resource'
import type { CapsuleResourceDriver } from '../../resource/driver'
import type { ForkExecution, ForkPlannedResource, ForkResourceRecord } from './types'

export interface ForkProviderDependencies {
  incus: IncusClient
  project: ProjectService
  resources: CapsuleBranchResourceStore
  driver: CapsuleResourceDriver
}

/**
 * Performs provider mutations authorized by one immutable fork execution plan.
 *
 * Every resource is resolved from the branch resource rows accepted with the
 * operation. Managed-volume sources cannot come from provider listing,
 * discovery, adoption, or inferred ownership. The owner project remains an
 * explicitly retained resource.
 */
export class ForkProvider {
  constructor(private readonly dependencies: ForkProviderDependencies) {}

  public async rootfs(input: ForkExecution): Promise<void> {
    await this.dependencies.incus.images.verify(input.plan.instance.rootfsImagePin)
  }

  public async project(input: ForkExecution): Promise<void> {
    const resource = this.resource(input, input.plan.project)
    try {
      await this.dependencies.project.ensureNamespace(input.ownerId)
      await this.dependencies.resources.recordBranchResourceAdoption(resource.id, input.operationId)
    } catch (error: unknown) {
      await this.markError(resource.id, error, {
        operationId: input.operationId,
        capsuleId: input.capsuleId,
        branchId: input.branchId,
        action: 'ensure_fork_project',
        resourceId: resource.id,
        resourceKey: resource.resourceKey,
      })
      throw error
    }
  }

  public async binds(input: ForkExecution): Promise<void> {
    for (const planned of input.plan.binds) {
      const resource = this.resource(input, planned)
      await this.dependencies.resources.recordBranchResourceAdoption(resource.id, input.operationId)
    }
  }

  public async volumes(input: ForkExecution): Promise<void> {
    const project = this.dependencies.incus.project(input.plan.project.namespace)
    for (const planned of input.plan.volumes) {
      const resource = this.resource(input, planned)
      let intentCommitted = false
      try {
        await this.dependencies.resources.recordBranchResourceCreateIntent(resource.id, input.operationId)
        intentCommitted = true
        await project.storage.cloneSnapshot(planned.pool, planned.volumeName, planned.source, planned.config)
      } catch (error: unknown) {
        if (intentCommitted) {
          await this.recordCreateFailure(input.operationId, resource, error, {
            operationId: input.operationId,
            capsuleId: input.capsuleId,
            branchId: input.branchId,
            action: 'clone_fork_snapshot_volume',
            blueprintVolumeName: planned.blueprintVolumeName,
            sourceProject: planned.source.project,
            sourcePool: planned.source.pool,
            sourceVolume: planned.source.volume,
            sourceSnapshot: planned.source.snapshot,
            targetPool: planned.pool,
            targetVolume: planned.volumeName,
          })
        }
        throw error
      }
      // A lost outcome acknowledgement must not overwrite a possibly committed
      // successful-create record. Compensation reloads durable accounting.
      await this.dependencies.resources.recordBranchResourceCreateOutcome(resource.id, input.operationId)
    }
  }

  public async instance(input: ForkExecution): Promise<void> {
    const planned = input.plan.instance
    const resource = this.resource(input, planned)
    let intentCommitted = false
    try {
      await this.dependencies.resources.recordBranchResourceCreateIntent(resource.id, input.operationId)
      intentCommitted = true
      await this.dependencies.driver.createInstance(input.plan.project.namespace, planned)
    } catch (error: unknown) {
      if (intentCommitted) {
        await this.recordCreateFailure(input.operationId, resource, error, {
          operationId: input.operationId,
          capsuleId: input.capsuleId,
          branchId: input.branchId,
          action: 'create_fork_instance',
          instanceName: planned.instanceName,
        })
      }
      throw error
    }
    await this.dependencies.resources.recordBranchResourceCreateOutcome(resource.id, input.operationId)
  }

  /**
   * Reconstructs only provisioning files on the rebuilt rootfs.
   *
   * Managed-volume entries are excluded from the plan. Cloned contents,
   * including intentional file edits and deletions, are never overwritten or
   * represented as individually verified historical provisioning files.
   */
  public async files(input: ForkExecution): Promise<void> {
    for (const planned of input.plan.files) {
      const resource = this.resource(input, planned)
      if (planned.target.target !== 'instance') {
        throw new IncusError('Fork provisioning may write only to the rebuilt instance rootfs.', 'CONFLICT', {
          operationId: input.operationId,
          branchId: input.branchId,
          resourceKey: planned.resourceKey,
        })
      }
      let intentCommitted = false
      try {
        await this.dependencies.resources.recordBranchResourceCreateIntent(resource.id, input.operationId)
        intentCommitted = true
        await this.dependencies.driver.writeProvisioningFile(
          input.plan.project.namespace,
          input.plan.instance.instanceName,
          planned,
        )
      } catch (error: unknown) {
        if (intentCommitted) {
          await this.recordCreateFailure(input.operationId, resource, error, {
            operationId: input.operationId,
            capsuleId: input.capsuleId,
            branchId: input.branchId,
            action: 'write_fork_rootfs_provisioning_file',
            instanceName: input.plan.instance.instanceName,
            path: planned.path,
          })
        }
        throw error
      }
      await this.dependencies.resources.recordBranchResourceCreateOutcome(resource.id, input.operationId)
    }
  }

  /**
   * Positively verifies that the materialized editable branch remains offline.
   */
  public async verify(input: ForkExecution): Promise<void> {
    const project = this.dependencies.incus.project(input.plan.project.namespace)
    const { data } = await project.instances.state(input.plan.instance.instanceName)
    if (data.status !== 'Stopped') {
      throw new IncusError('Forked capsule branch instance is not positively confirmed offline.', 'CONFLICT', {
        operationId: input.operationId,
        capsuleId: input.capsuleId,
        branchId: input.branchId,
        instanceName: input.plan.instance.instanceName,
        providerStatus: data.status,
      })
    }
  }

  private resource(input: ForkExecution, planned: ForkPlannedResource): ForkResourceRecord {
    const matches = input.resources.filter(resource => resource.resourceKey === planned.resourceKey)
    const resource = matches[0]
    if (
      matches.length !== 1 ||
      !resource ||
      resource.ownerId !== input.ownerId ||
      resource.branchId !== input.branchId ||
      resource.branchName !== input.branchName ||
      resource.createdByOperationId !== input.operationId ||
      resource.lastOperationId !== input.operationId ||
      resource.provider !== planned.provider ||
      resource.resourceType !== planned.resourceType ||
      resource.blueprintVolumeName !== planned.blueprintVolumeName ||
      resource.cleanupPolicy !== planned.cleanupPolicy
    ) {
      throw new IncusError('Fork execution could not resolve exactly one attributed accepted resource.', 'CONFLICT', {
        operationId: input.operationId,
        branchId: input.branchId,
        resourceKey: planned.resourceKey,
        resourceCount: matches.length,
      })
    }
    return resource
  }

  private async recordCreateFailure(
    operationId: string,
    resource: ForkResourceRecord,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.dependencies.resources.recordBranchResourceCreateFailure(resource.id, operationId, error, context)
    } catch (persistenceError: unknown) {
      console.error(`[ForkProvider] Failed to persist create failure for fork resource '${resource.id}'.`, {
        providerError: error,
        persistenceError,
      })
    }
  }

  private async markError(resourceId: string, error: unknown, context: Record<string, unknown>): Promise<void> {
    try {
      await this.dependencies.resources.markBranchResourceError(resourceId, error, context)
    } catch (persistenceError: unknown) {
      console.error(`[ForkProvider] Failed to persist uncertainty for fork resource '${resourceId}'.`, {
        providerError: error,
        persistenceError,
      })
    }
  }
}
