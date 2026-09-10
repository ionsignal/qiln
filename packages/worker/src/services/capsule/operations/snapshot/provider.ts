import { IncusError } from '../../../../errors'
import { failureCodeFromUnknown } from '../../failures'
import type { IncusClient } from '../../../../incus/client'
import type { SnapshotRepository } from './persistence'
import type { SnapshotCompensation, SnapshotExecution, SnapshotResource } from './types'

export interface SnapshotProviderDependencies {
  incus: IncusClient
  repository: SnapshotRepository
}

/**
 * Uses only provider identities accepted into the snapshot resource ledger.
 *
 * Filesystem APIs, provider listing, inferred baselines, and bind contents are
 * outside this boundary.
 */
export class SnapshotProvider {
  constructor(private readonly dependencies: SnapshotProviderDependencies) {}

  public async verify(input: SnapshotExecution): Promise<void> {
    await this.dependencies.incus.images.verify(input.rootfsImagePin)
    await this.offline(input)
  }

  public async offline(input: SnapshotExecution): Promise<void> {
    const { data } = await this.dependencies.incus.project(input.plan.project).instances.state(input.plan.instanceName)
    if (data.status !== 'Stopped') {
      throw new IncusError('Snapshot source runtime is not positively confirmed offline.', 'CONFLICT', {
        operationId: input.operationId,
        branchId: input.sourceBranchId,
        providerStatus: data.status,
      })
    }
  }

  public async create(input: SnapshotExecution): Promise<void> {
    for (const volume of input.plan.volumes) {
      const resource = await this.dependencies.repository.creating(input.operationId, volume.blueprintVolumeName)
      try {
        await this.dependencies.incus
          .project(resource.project)
          .storage.snapshots.create(resource.pool, resource.sourceVolume, resource.snapshotName)
      } catch (error: unknown) {
        await this.recordError(resource, error)
        throw error
      }
      // A failed outcome write must not erase a possibly committed `created`
      // record or authorize compensation from process-local knowledge alone.
      await this.dependencies.repository.created(input.operationId, resource.id)
    }
  }

  public async compensate(operationId: string): Promise<SnapshotCompensation> {
    const resources = await this.dependencies.repository.resources(operationId)
    const failures: SnapshotCompensation['failures'] = []
    for (const resource of [...resources].reverse()) {
      if (resource.status === 'planned' || resource.status === 'deleted' || resource.status === 'missing') {
        continue
      }
      if (resource.status !== 'created') {
        failures.push({
          resourceId: resource.id,
          code: 'SNAPSHOT_RESOURCE_OUTCOME_UNCERTAIN',
        })
        continue
      }
      try {
        await this.remove(resource)
      } catch (error: unknown) {
        failures.push({
          resourceId: resource.id,
          code: failureCodeFromUnknown(error),
        })
      }
    }
    return {
      complete: failures.length === 0,
      failures,
    }
  }

  private async remove(resource: SnapshotResource): Promise<void> {
    const deleting = await this.dependencies.repository.deleting(resource.operationId, resource.id)
    let outcome: 'deleted' | 'missing' = 'deleted'
    try {
      await this.dependencies.incus
        .project(deleting.project)
        .storage.snapshots.delete(deleting.pool, deleting.sourceVolume, deleting.snapshotName)
    } catch (error: unknown) {
      if (error instanceof IncusError && error.code === 'NOT_FOUND') {
        outcome = 'missing'
      } else {
        await this.recordError(deleting, error)
        throw error
      }
    }
    // Provider errors and persistence errors are separate so a failed outcome
    // write cannot be mistaken for a provider-confirmed missing snapshot.
    await this.dependencies.repository.deleted(resource.operationId, resource.id, outcome)
  }

  private async recordError(resource: SnapshotResource, error: unknown): Promise<void> {
    try {
      await this.dependencies.repository.resourceError(resource.operationId, resource.id, error)
    } catch (persistenceError: unknown) {
      console.error('[SnapshotProvider] Failed to persist snapshot provider uncertainty.', {
        operationId: resource.operationId,
        resourceId: resource.id,
        providerError: error,
        persistenceError,
      })
    }
  }
}
