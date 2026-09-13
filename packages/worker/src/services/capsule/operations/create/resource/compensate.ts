import { IncusError } from '../../../../../errors'
import { createCreateCapsuleCompensationFailure } from '../execution/diagnostics'
import { CreatePhase } from '../execution/phases'
import type { CreateCapsuleCompensationScope, CreateCapsuleCompensationTarget } from '../execution/state'
import type { CreateCapsuleCompensationFailure, CreateCapsuleCompensationResult } from '../types'
import type { CapsuleResourceDriver } from '../../../resource/driver'
import type { CapsuleBranchResourceStore } from '../../../resource/store'

export interface CreateCapsuleCompensationDependencies {
  resources: CapsuleBranchResourceStore
  driver: CapsuleResourceDriver
}

export interface CreateCapsuleCompensationContext {
  operationId: string
  namespace: string
}

/**
 * Compensates only direct provider resources with a durable successful-create
 * outcome recorded by this process.
 */
export class CreateCapsuleCompensation {
  constructor(private readonly dependencies: CreateCapsuleCompensationDependencies) {}

  public async compensate(
    context: CreateCapsuleCompensationContext,
    scope: CreateCapsuleCompensationScope,
  ): Promise<CreateCapsuleCompensationResult> {
    const failures: CreateCapsuleCompensationFailure[] = []
    const terminalBackingResourceIds = new Set<string>()
    for (const target of scope.listDirectTargetsInCompensationOrder()) {
      try {
        await this.compensateTarget(context, target)
        terminalBackingResourceIds.add(target.resourceId)
      } catch (error: unknown) {
        failures.push(
          createCreateCapsuleCompensationFailure({
            action: target.kind === 'instance' ? 'compensate_delete_instance' : 'compensate_delete_volume',
            resourceId: target.resourceId,
            resourceKey: target.resourceKey,
            error,
          }),
        )
      }
    }
    for (const file of scope.listDerivedProvisioningFiles()) {
      if (!terminalBackingResourceIds.has(file.backingResourceId)) {
        continue
      }
      try {
        await this.dependencies.resources.compensated(file.resource)
      } catch (error: unknown) {
        failures.push(
          createCreateCapsuleCompensationFailure({
            action: 'finalize_compensated_provisioning_file',
            resourceId: file.resourceId,
            resourceKey: file.resourceKey,
            error,
          }),
        )
      }
    }
    return {
      fullyCompensated: failures.length === 0,
      failures,
    }
  }

  private async compensateTarget(
    context: CreateCapsuleCompensationContext,
    target: CreateCapsuleCompensationTarget,
  ): Promise<void> {
    if (target.resource.operationId !== context.operationId) {
      throw new IncusError('Compensation target belongs to another create operation.', 'CONFLICT', {
        operationId: context.operationId,
        resourceId: target.resourceId,
      })
    }
    await this.dependencies.resources.deleting(target.resource)
    let outcome: 'deleted' | 'missing' = 'deleted'
    try {
      if (target.kind === 'instance') {
        await this.dependencies.driver.deleteInstance(context.namespace, target.instanceName)
      } else {
        await this.dependencies.driver.deleteVolume(context.namespace, {
          pool: target.pool,
          volumeName: target.volumeName,
        })
      }
    } catch (error: unknown) {
      if (error instanceof IncusError && error.code === 'NOT_FOUND') {
        outcome = 'missing'
      } else {
        await this.recordDeleteFailure(target, error)
        throw error
      }
    }
    try {
      await this.dependencies.resources.deleted(target.resource, outcome)
    } catch (error: unknown) {
      await this.recordDeleteFailure(target, error)
      throw error
    }
  }

  private async recordDeleteFailure(target: CreateCapsuleCompensationTarget, error: unknown): Promise<void> {
    try {
      await this.dependencies.resources.deleteFailed(target.resource, error, {
        operationId: target.resource.operationId,
        phase: CreatePhase.COMPENSATION,
        action: target.kind === 'instance' ? 'compensate_delete_instance' : 'compensate_delete_volume',
        resourceId: target.resourceId,
        resourceKey: target.resourceKey,
      })
    } catch (persistenceError: unknown) {
      console.error(
        `[CreateCapsuleCompensation] Failed to persist compensation failure for resource '${target.resourceId}'.`,
        persistenceError,
      )
    }
  }
}
