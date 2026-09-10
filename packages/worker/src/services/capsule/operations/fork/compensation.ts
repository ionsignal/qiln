import { CapsuleBranchResourceStatus, CapsuleBranchResourceType } from '@qiln/core/server'
import { IncusError } from '../../../../errors'
import { failureCodeFromUnknown, failureMessageFromUnknown, normalizeFailureDetails } from '../../failures'
import type { IncusClient } from '../../../../incus/client'
import type { CapsuleBranchResourceStore } from '../../resource'
import type { ForkRepository } from './persistence'
import type { ForkInstanceResource, ForkResourceRecord, ForkVolumeResource } from './types'

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
  repository: ForkRepository
}

/**
 * Compensates only direct resources whose successful creation is durably
 * recorded.
 *
 * Planned direct resources have no recorded create intent. Creating, deleting,
 * and error states remain uncertain and prevent ordinary compensated failure.
 *
 * Every accounting read re-proves the complete immutable plan. Missing rows
 * cannot count as successful cleanup, and abandoned forks never call this
 * process-local execution capability.
 */
export class ForkCompensation {
  constructor(private readonly dependencies: ForkCompensationDependencies) {}

  public async run(operationId: string): Promise<ForkCompensationResult> {
    const failures: ForkCompensationFailure[] = []
    const input = await this.dependencies.repository.compensation(operationId)
    const direct = [...input.plan.volumes, input.plan.instance].reverse()
    for (const target of direct) {
      const resource = this.find(input.resources, target.resourceKey)
      if (!resource) {
        failures.push(this.missing(target.resourceKey))
        continue
      }
      if (!this.pristine(resource)) {
        failures.push(this.uncertain(resource))
        continue
      }
      if (
        resource.status === CapsuleBranchResourceStatus.PLANNED ||
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
        await this.delete(operationId, input.plan.project.namespace, target, resource)
      } catch (error: unknown) {
        failures.push(this.failure(resource, error))
      }
    }
    const materialized = await this.dependencies.repository.compensation(operationId)
    const resourcesByKey = new Map(materialized.resources.map(resource => [resource.resourceKey, resource] as const))
    const backing = resourcesByKey.get(materialized.plan.instance.resourceKey)
    for (const file of materialized.plan.files) {
      const resource = resourcesByKey.get(file.resourceKey)
      if (!resource) {
        failures.push(this.missing(file.resourceKey))
        continue
      }
      if (
        this.pristine(resource) &&
        (resource.status === CapsuleBranchResourceStatus.PLANNED ||
          resource.status === CapsuleBranchResourceStatus.DELETED)
      ) {
        continue
      }
      if (
        !backing ||
        !this.pristine(backing) ||
        (backing.status !== CapsuleBranchResourceStatus.DELETED &&
          backing.status !== CapsuleBranchResourceStatus.MISSING)
      ) {
        failures.push({
          resourceId: resource.id,
          resourceKey: resource.resourceKey,
          code: 'FORK_DERIVED_RESOURCE_BACKING_UNCERTAIN',
          message: 'Fork provisioning-file backing instance is not terminal.',
          details: {
            backingResourceKey: materialized.plan.instance.resourceKey,
            backingResourceId: backing?.id ?? null,
            backingResourceStatus: backing?.status ?? null,
          },
        })
        continue
      }
      try {
        await this.dependencies.resources.recordDerivedResourceCompensation(resource.id, operationId)
      } catch (error: unknown) {
        failures.push(this.failure(resource, error))
      }
    }
    const final = await this.dependencies.repository.compensation(operationId)
    for (const resource of final.resources) {
      if (!this.isCompensated(resource) && !failures.some(failure => failure.resourceId === resource.id)) {
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
    namespace: string,
    target: ForkVolumeResource | ForkInstanceResource,
    resource: ForkResourceRecord,
  ): Promise<void> {
    await this.dependencies.resources.recordBranchResourceDeleteIntent(resource.id, operationId)
    const project = this.dependencies.incus.project(namespace)
    let outcome: 'deleted' | 'missing' = 'deleted'
    try {
      if (target.kind === 'instance') {
        await project.instances.delete(target.instanceName)
      } else {
        await project.storage.delete(target.pool, target.volumeName)
      }
    } catch (error: unknown) {
      if (error instanceof IncusError && error.code === 'NOT_FOUND') {
        outcome = 'missing'
      } else {
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
    // Persistence failures are not provider-confirmed absence. A lost outcome
    // acknowledgement is resolved only through a fresh accounting read.
    await this.dependencies.resources.recordBranchResourceDeleteOutcome(resource.id, operationId, outcome)
  }

  private find(resources: readonly ForkResourceRecord[], resourceKey: string): ForkResourceRecord | undefined {
    return resources.find(resource => resource.resourceKey === resourceKey)
  }

  private pristine(resource: ForkResourceRecord): boolean {
    return resource.failureCode === null && resource.failureMessage === null && resource.failureDetails === null
  }

  private isCompensated(resource: ForkResourceRecord): boolean {
    if (!this.pristine(resource)) {
      return false
    }
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

  private uncertain(resource: ForkResourceRecord): ForkCompensationFailure {
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

  private failure(resource: ForkResourceRecord, error: unknown): ForkCompensationFailure {
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
