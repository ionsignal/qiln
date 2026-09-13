import { IncusError } from '../../../../../errors'
import { isObservedTerminalProviderFailure } from '../../../../../incus/client/transport/response'
import type { IncusClient } from '../../../../../incus/client'
import type { DestroyResources } from '../persistence/resources'
import type { DestroyInstance, DestroyProviderTarget, DestroyVolume } from '../types'

export interface DestroyCapsuleProviderDependencies {
  incus: IncusClient
  resources: DestroyResources
}

/**
 * Executes only independently proven managed resource identities.
 *
 * An HTTP 404 alone is not positive absence evidence. Missing outcomes require
 * a validated Incus error envelope, and successful deletes receive read-only
 * absence verification.
 */
export class DestroyCapsuleProvider {
  constructor(private readonly dependencies: DestroyCapsuleProviderDependencies) {}

  public async deleteInstances(operationId: string, targets: readonly DestroyInstance[]): Promise<void> {
    for (const target of targets) {
      await this.delete(operationId, target, async () => {
        const instances = this.dependencies.incus.project(target.namespace).instances
        const state = await instances.state(target.instanceName)
        if (state.data.status === 'Running') {
          await instances.stop(target.instanceName)
        } else if (state.data.status !== 'Stopped') {
          throw new IncusError('Managed instance is in an unsupported state for deletion.', 'CONFLICT', {
            resourceId: target.id,
            status: state.data.status,
          })
        }
        await instances.delete(target.instanceName)
        await this.assertAbsent(() => instances.get(target.instanceName), target)
      })
    }
  }

  public async deleteVolumes(operationId: string, targets: readonly DestroyVolume[]): Promise<void> {
    for (const target of targets) {
      await this.delete(operationId, target, async () => {
        const storage = this.dependencies.incus.project(target.namespace).storage
        await storage.delete(target.pool, target.volumeName)
        await this.assertAbsent(() => storage.get(target.pool, target.volumeName), target)
      })
    }
  }

  private async delete(
    operationId: string,
    target: DestroyProviderTarget,
    action: () => Promise<void>,
  ): Promise<void> {
    await this.dependencies.resources.intent(operationId, target)
    try {
      let outcome: 'deleted' | 'missing' = 'deleted'
      try {
        await action()
      } catch (error: unknown) {
        if (!this.isMissing(error)) {
          throw error
        }
        outcome = 'missing'
      }
      await this.dependencies.resources.outcome(operationId, target, outcome)
    } catch (error: unknown) {
      try {
        await this.dependencies.resources.failure(operationId, target, error)
      } catch (persistenceError: unknown) {
        console.error('[DestroyCapsuleProvider] Failed to persist deletion failure.', {
          operationId,
          resourceId: target.id,
          persistenceError,
        })
      }
      throw error
    }
  }

  private async assertAbsent(read: () => Promise<unknown>, target: DestroyProviderTarget): Promise<void> {
    try {
      await read()
    } catch (error: unknown) {
      if (this.isMissing(error)) {
        return
      }
      throw error
    }
    throw new IncusError('Managed resource remained present after deletion.', 'CONFLICT', {
      resourceId: target.id,
      resourceKey: target.resourceKey,
    })
  }

  private isMissing(error: unknown): boolean {
    return isObservedTerminalProviderFailure(error) && error.code === 'NOT_FOUND'
  }
}
