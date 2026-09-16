import type { CapsuleDestroyObservation, CapsuleDestroyTarget } from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { isObservedTerminalProviderFailure } from '../../../../../incus/client/transport/response'
import type { IncusClient } from '../../../../../incus/client'
import type { ProjectService } from '../../../../project'
import type { DestroyTargets } from '../persistence/targets'
import type { DestroyExecution, DestroyTarget } from '../types'

type IncusTarget = Exclude<CapsuleDestroyTarget, { kind: 'route' }>

export interface DestroyCapsuleProviderDependencies {
  incus: IncusClient
  projects: ProjectService
  targets: DestroyTargets
}

/**
 * Deletes only targets from this attempt's immutable ledger.
 *
 * Resource reads establish absence. A missing asynchronous-operation record
 * never establishes absence of an instance, volume, or snapshot.
 */
export class DestroyCapsuleProvider {
  constructor(private readonly dependencies: DestroyCapsuleProviderDependencies) {}

  public async instances(execution: DestroyExecution): Promise<void> {
    for (const resource of execution.targets) {
      if (resource.target.kind === 'instance') {
        await this.remove(execution, resource)
      }
    }
  }

  public async storage(execution: DestroyExecution): Promise<void> {
    // The persisted target set was ordered using immutable fork dependencies.
    for (const resource of execution.targets) {
      if (resource.target.kind === 'snapshot' || resource.target.kind === 'volume') {
        await this.remove(execution, resource)
      }
    }
  }

  private async remove(execution: DestroyExecution, resource: DestroyTarget): Promise<void> {
    if (resource.target.kind === 'route') {
      throw new IncusError('Incus deletion cannot consume a Caddy target.', 'CONFLICT')
    }
    const target = resource.target
    let before: CapsuleDestroyObservation
    try {
      before = await this.inspect(execution.ownerId, target)
    } catch (error: unknown) {
      await this.dependencies.targets.inspect(execution.operationId, resource.id, this.unresolved(target))
      throw error
    }
    await this.dependencies.targets.inspect(execution.operationId, resource.id, before)
    if (before.state === 'absent') {
      return
    }
    await this.dependencies.targets.intent(execution.operationId, resource.id)
    let mutationError: unknown
    try {
      await this.delete(target)
    } catch (error: unknown) {
      mutationError = error
    }
    let after: CapsuleDestroyObservation
    try {
      after = await this.inspect(execution.ownerId, target)
    } catch (error: unknown) {
      await this.dependencies.targets.settle(execution.operationId, resource.id, this.unresolved(target))
      throw error
    }
    await this.dependencies.targets.settle(execution.operationId, resource.id, after)
    if (after.state !== 'absent') {
      throw new IncusError('Managed resource remains present after the deletion attempt.', 'CONFLICT', {
        resourceId: resource.id,
        mutationFailed: mutationError !== undefined,
      })
    }
  }

  private async inspect(ownerId: string, target: IncusTarget): Promise<CapsuleDestroyObservation> {
    if (target.project !== this.dependencies.projects.getNamespace(ownerId)) {
      throw new IncusError('Deletion target is outside its proven owner namespace.', 'CONFLICT')
    }
    const namespace = await this.dependencies.projects.verify(ownerId)
    if (namespace === null) {
      return {
        target,
        state: 'absent',
        observedAt: new Date().toISOString(),
        details: { ownerProjectAbsent: true },
      }
    }
    const project = this.dependencies.incus.project(target.project)
    await project.operations.assertIdle()
    let present = true
    try {
      switch (target.kind) {
        case 'instance': {
          const { data } = await project.instances.get(target.instanceName)
          if (data.name !== target.instanceName) {
            throw new IncusError('Incus instance read returned another provider identity.', 'CONFLICT')
          }
          break
        }
        case 'volume':
          await project.storage.get(target.pool, target.volumeName)
          break
        case 'snapshot':
          await project.storage.snapshots.get(target.pool, target.volumeName, target.snapshotName)
          break
      }
    } catch (error: unknown) {
      if (!isObservedTerminalProviderFailure(error) || error.code !== 'NOT_FOUND') {
        throw error
      }
      present = false
    }
    // A resource read must not conceal an earlier operation still completing.
    await project.operations.assertIdle()
    return {
      target,
      state: present ? 'present' : 'absent',
      observedAt: new Date().toISOString(),
      details: { ownerProjectVerified: true, providerActivityIdle: true },
    }
  }

  private async delete(target: IncusTarget): Promise<void> {
    const project = this.dependencies.incus.project(target.project)
    switch (target.kind) {
      case 'instance': {
        const { data } = await project.instances.state(target.instanceName)
        if (data.status === 'Running') {
          await project.instances.stop(target.instanceName)
        } else if (data.status !== 'Stopped') {
          throw new IncusError('Instance is not in a supported state for deletion.', 'CONFLICT', {
            instanceName: target.instanceName,
            providerStatus: data.status,
          })
        }
        await project.instances.delete(target.instanceName)
        return
      }
      case 'snapshot':
        await project.storage.snapshots.delete(target.pool, target.volumeName, target.snapshotName)
        return
      case 'volume':
        await project.storage.delete(target.pool, target.volumeName)
    }
  }

  private unresolved(target: IncusTarget): CapsuleDestroyObservation {
    return {
      target,
      state: 'unresolved',
      observedAt: new Date().toISOString(),
      details: { reason: 'provider_observation_unresolved' },
    }
  }
}
