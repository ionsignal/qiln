import { CapsuleBranchResourceStatus } from '@qiln/core/server'
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
 * operation. No provider listing, discovery, adoption, or inferred ownership is
 * allowed.
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
        await this.dependencies.resources.recordBranchResourceCreateOutcome(resource.id, input.operationId)
      } catch (error: unknown) {
        if (intentCommitted) {
          await this.recordCreateFailure(resource, error, {
            operationId: input.operationId,
            capsuleId: input.capsuleId,
            branchId: input.branchId,
            action: 'clone_fork_snapshot_volume',
            artifactRootId: planned.artifactRootId,
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
      await this.dependencies.resources.recordBranchResourceCreateOutcome(resource.id, input.operationId)
    } catch (error: unknown) {
      if (intentCommitted) {
        await this.recordCreateFailure(resource, error, {
          operationId: input.operationId,
          capsuleId: input.capsuleId,
          branchId: input.branchId,
          action: 'create_fork_instance',
          instanceName: planned.instanceName,
        })
      }
      throw error
    }
  }

  /**
   * Restores provisioning-file accounting without overwriting captured volume
   * state. Files targeting managed volumes already exist in cloned snapshot
   * storage.
   */
  public async files(input: ForkExecution): Promise<void> {
    const currentResources = await this.dependencies.resources.listBranchResourceInventoryByBranchId(input.branchId)
    const currentByKey = new Map(currentResources.map(resource => [resource.resourceKey, resource] as const))
    for (const planned of input.plan.files) {
      const resource = this.resource(input, planned)
      const current = currentByKey.get(planned.resourceKey)
      if (!current || current.id !== resource.id) {
        throw new IncusError(
          'Fork provisioning file resource was not found after provider materialization.',
          'CONFLICT',
          {
            operationId: input.operationId,
            branchId: input.branchId,
            resourceKey: planned.resourceKey,
            acceptedResourceId: resource.id,
            currentResourceId: current?.id ?? null,
          },
        )
      }
      const target = planned.target
      if (planned.restoredByClone) {
        if (target.target !== 'volume') {
          throw new IncusError('Fork file marked snapshot-restored does not target a managed volume.', 'CONFLICT', {
            operationId: input.operationId,
            branchId: input.branchId,
            resourceKey: planned.resourceKey,
          })
        }
        const plannedVolume = input.plan.volumes.find(
          volume => volume.pool === target.pool && volume.volumeName === target.volumeName,
        )
        const backing = plannedVolume ? currentByKey.get(plannedVolume.resourceKey) : undefined
        if (!backing || backing.status !== CapsuleBranchResourceStatus.CREATED) {
          throw new IncusError('Fork snapshot-restored file has no positively created backing volume.', 'CONFLICT', {
            operationId: input.operationId,
            branchId: input.branchId,
            resourceKey: planned.resourceKey,
            backingResourceId: backing?.id ?? null,
            backingResourceStatus: backing?.status ?? null,
          })
        }
        await this.dependencies.resources.recordDerivedResourceRestore(resource.id, input.operationId)
        continue
      }
      if (target.target !== 'instance') {
        throw new IncusError('Fork file requiring a provider write does not target the rebuilt instance.', 'CONFLICT', {
          operationId: input.operationId,
          branchId: input.branchId,
          resourceKey: planned.resourceKey,
          target: target.target,
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
        await this.dependencies.resources.recordBranchResourceCreateOutcome(resource.id, input.operationId)
      } catch (error: unknown) {
        if (intentCommitted) {
          await this.recordCreateFailure(resource, error, {
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
    if (matches.length !== 1) {
      throw new IncusError('Fork execution could not resolve exactly one accepted resource row.', 'CONFLICT', {
        operationId: input.operationId,
        branchId: input.branchId,
        resourceKey: planned.resourceKey,
        resourceCount: matches.length,
      })
    }
    return matches[0]!
  }

  private async recordCreateFailure(
    resource: ForkResourceRecord,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.dependencies.resources.recordBranchResourceCreateFailure(
        resource.id,
        resource.createdByOperationId!,
        error,
        context,
      )
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
