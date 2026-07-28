import { CapsuleBranchResourceStatus, CapsuleBranchResourceType } from '@qiln/core/server'
import { IncusError } from '../../../../errors'
import { failureCodeFromUnknown, failureMessageFromUnknown, normalizeFailureDetails } from '../../failures'
import type { IncusClient } from '../../../../incus/client'
import type { CapsuleBranchResourceStore, CapsuleBranchResourceInventoryRow } from '../../resource'
import type { ForkExecution, ForkFileResource, ForkInstanceResource, ForkVolumeResource } from './types'

export interface ForkCompensationFailure {
  resourceId: string
  resourceKey: string
  code: string
  message: string
  details?: Record<string, unknown>
}

export interface ForkCompensationResult {
  complete: boolean
  failures: readonly ForkCompensationFailure[]
}

export interface ForkCompensationDependencies {
  incus: IncusClient
  resources: CapsuleBranchResourceStore
}

/**
 * Compensates only direct resources whose successful creation is durably
 * recorded.
 *
 * Planned resources are proven untouched. Creating, deleting, and error states
 * remain uncertain and prevent ordinary compensated failure.
 */
export class ForkCompensation {
  constructor(private readonly dependencies: ForkCompensationDependencies) {}

  public async run(input: ForkExecution): Promise<ForkCompensationResult> {
    const failures: ForkCompensationFailure[] = []
    let resources = await this.dependencies.resources.listBranchResourceInventoryByBranchId(input.branchId)
    const direct = [...input.plan.volumes, input.plan.instance].reverse()
    for (const target of direct) {
      const resource = this.find(resources, target.resourceKey)
      if (!resource) {
        failures.push(this.missing(target.resourceKey))
        continue
      }
      if (resource.status === CapsuleBranchResourceStatus.PLANNED) {
        continue
      }
      if (
        resource.status === CapsuleBranchResourceStatus.DELETED ||
        resource.status === CapsuleBranchResourceStatus.MISSING
      ) {
        continue
      }
      if (resource.status !== CapsuleBranchResourceStatus.CREATED) {
        failures.push(this.uncertain(resource))
        continue
      }
      try {
        await this.delete(input.operationId, target, resource)
      } catch (error: unknown) {
        failures.push(this.failure(resource, error))
      }
    }
    resources = await this.dependencies.resources.listBranchResourceInventoryByBranchId(input.branchId)
    const resourcesByKey = new Map(resources.map(resource => [resource.resourceKey, resource] as const))
    for (const file of input.plan.files) {
      const resource = resourcesByKey.get(file.resourceKey)
      if (!resource) {
        failures.push(this.missing(file.resourceKey))
        continue
      }
      if (resource.status === CapsuleBranchResourceStatus.PLANNED) {
        continue
      }
      if (resource.status === CapsuleBranchResourceStatus.DELETED) {
        continue
      }
      const backingKey = this.backing(input, file)
      const backing = resourcesByKey.get(backingKey)
      if (
        !backing ||
        (backing.status !== CapsuleBranchResourceStatus.DELETED &&
          backing.status !== CapsuleBranchResourceStatus.MISSING)
      ) {
        failures.push({
          resourceId: resource.id,
          resourceKey: resource.resourceKey,
          code: 'FORK_DERIVED_RESOURCE_BACKING_UNCERTAIN',
          message: 'Fork provisioning-file backing resource is not terminal.',
          details: {
            backingResourceKey: backingKey,
            backingResourceId: backing?.id ?? null,
            backingResourceStatus: backing?.status ?? null,
          },
        })
        continue
      }
      try {
        await this.dependencies.resources.recordDerivedResourceCompensation(resource.id, input.operationId)
      } catch (error: unknown) {
        failures.push(this.failure(resource, error))
      }
    }
    resources = await this.dependencies.resources.listBranchResourceInventoryByBranchId(input.branchId)
    const nonterminal = resources.filter(resource => !this.isCompensated(resource))
    for (const resource of nonterminal) {
      if (!failures.some(failure => failure.resourceId === resource.id)) {
        failures.push(this.uncertain(resource))
      }
    }
    return {
      complete: failures.length === 0,
      failures,
    }
  }

  private async delete(
    operationId: string,
    target: ForkVolumeResource | ForkInstanceResource,
    resource: CapsuleBranchResourceInventoryRow,
  ): Promise<void> {
    await this.dependencies.resources.recordBranchResourceDeleteIntent(resource.id, operationId)
    const namespace = this.namespace(target)
    const project = this.dependencies.incus.project(namespace)
    try {
      if (target.kind === 'instance') {
        await project.instances.delete(target.instanceName)
      } else {
        await project.storage.delete(target.pool, target.volumeName)
      }
      await this.dependencies.resources.recordBranchResourceDeleteOutcome(
        resource.id,
        operationId,
        CapsuleBranchResourceStatus.DELETED,
      )
    } catch (error: unknown) {
      if (error instanceof IncusError && error.code === 'NOT_FOUND') {
        await this.dependencies.resources.recordBranchResourceDeleteOutcome(
          resource.id,
          operationId,
          CapsuleBranchResourceStatus.MISSING,
        )
        return
      }
      try {
        await this.dependencies.resources.recordBranchResourceDeleteFailure(resource.id, operationId, error, {
          operationId,
          action: target.kind === 'instance' ? 'compensate_fork_instance' : 'compensate_fork_volume',
          resourceId: resource.id,
          resourceKey: resource.resourceKey,
        })
      } catch (persistenceError: unknown) {
        console.error(`[ForkCompensation] Failed to persist compensation failure for '${resource.id}'.`, {
          providerError: error,
          persistenceError,
        })
      }
      throw error
    }
  }

  private namespace(target: ForkVolumeResource | ForkInstanceResource): string {
    const namespace = target.metadata.namespace
    if (typeof namespace !== 'string' || namespace.trim() === '') {
      throw new IncusError('Fork compensation target has invalid namespace metadata.', 'CONFLICT', {
        resourceKey: target.resourceKey,
      })
    }
    return namespace
  }

  private backing(input: ForkExecution, file: ForkFileResource): string {
    if (file.target.target === 'instance') {
      return input.plan.instance.resourceKey
    }
    const target = file.target
    const volume = input.plan.volumes.find(
      candidate => candidate.pool === target.pool && candidate.volumeName === target.volumeName,
    )
    if (!volume) {
      throw new IncusError('Fork provisioning file cannot resolve its managed backing volume.', 'CONFLICT', {
        operationId: input.operationId,
        branchId: input.branchId,
        resourceKey: file.resourceKey,
        pool: target.pool,
        volumeName: target.volumeName,
      })
    }
    return volume.resourceKey
  }

  private find(
    resources: readonly CapsuleBranchResourceInventoryRow[],
    resourceKey: string,
  ): CapsuleBranchResourceInventoryRow | undefined {
    return resources.find(resource => resource.resourceKey === resourceKey)
  }

  private isCompensated(resource: CapsuleBranchResourceInventoryRow): boolean {
    if (
      resource.resourceType === CapsuleBranchResourceType.INCUS_PROJECT ||
      resource.resourceType === CapsuleBranchResourceType.BIND_MOUNT
    ) {
      return (
        resource.status === CapsuleBranchResourceStatus.PLANNED ||
        resource.status === CapsuleBranchResourceStatus.ADOPTED
      )
    }
    if (
      resource.resourceType === CapsuleBranchResourceType.INCUS_INSTANCE ||
      resource.resourceType === CapsuleBranchResourceType.ZFS_VOLUME
    ) {
      return (
        resource.status === CapsuleBranchResourceStatus.PLANNED ||
        resource.status === CapsuleBranchResourceStatus.DELETED ||
        resource.status === CapsuleBranchResourceStatus.MISSING
      )
    }
    if (resource.resourceType === CapsuleBranchResourceType.PROVISIONING_FILE) {
      return (
        resource.status === CapsuleBranchResourceStatus.PLANNED ||
        resource.status === CapsuleBranchResourceStatus.DELETED
      )
    }
    return false
  }

  private missing(resourceKey: string): ForkCompensationFailure {
    return {
      resourceId: 'missing',
      resourceKey,
      code: 'FORK_RESOURCE_MISSING',
      message: 'Fork compensation could not resolve an accepted resource.',
    }
  }

  private uncertain(resource: CapsuleBranchResourceInventoryRow): ForkCompensationFailure {
    return {
      resourceId: resource.id,
      resourceKey: resource.resourceKey,
      code: 'FORK_RESOURCE_OUTCOME_UNCERTAIN',
      message: 'Fork resource outcome is not safe for compensation.',
      details: {
        resourceType: resource.resourceType,
        resourceStatus: resource.status,
      },
    }
  }

  private failure(resource: CapsuleBranchResourceInventoryRow, error: unknown): ForkCompensationFailure {
    const failure: ForkCompensationFailure = {
      resourceId: resource.id,
      resourceKey: resource.resourceKey,
      code: failureCodeFromUnknown(error),
      message: failureMessageFromUnknown(error, 'Fork compensation failed.'),
    }
    const details = normalizeFailureDetails(error)
    if (details !== undefined) {
      failure.details = details
    }
    return failure
  }
}
