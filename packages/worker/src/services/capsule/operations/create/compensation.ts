import { CapsuleBranchResourceStatus } from '@qiln/core/server'
import { IncusError } from '../../../../errors'
import { CreateCapsuleFailurePhase, createCreateCapsuleCompensationFailure, type CreateCapsuleCompensationFailure } from './failureContext'
import type {
  CreateCapsuleCompensationScope,
  CreateCapsuleCompensationTarget,
  CreateCapsuleInstanceCompensationTarget,
  CreateCapsuleVolumeCompensationTarget,
} from './executionState'
import type { CapsuleResourceDriver } from '../../resource/driver'
import type { CapsuleBranchResourceStore } from '../../resource/store'

export interface CreateCapsuleCompensationResult {
  fullyCompensated: boolean
  failures: CreateCapsuleCompensationFailure[]
}

export interface CreateCapsuleCompensationDependencies {
  resources: CapsuleBranchResourceStore
  driver: CapsuleResourceDriver
}

export interface CreateCapsuleCompensationContext {
  operationId: string
  namespace: string
  rootBranchName: string
}

/**
 * Compensates only direct provider resources with a durable successful-create
 * outcome recorded by this process.
 */
export class CreateCapsuleCompensation {
  constructor(private readonly dependencies: CreateCapsuleCompensationDependencies) {}

  public async compensateCreatedResources(
    context: CreateCapsuleCompensationContext,
    compensationScope: CreateCapsuleCompensationScope,
  ): Promise<CreateCapsuleCompensationResult> {
    const failures: CreateCapsuleCompensationFailure[] = []
    const terminalBackingResourceIds = new Set<string>()

    for (const target of compensationScope.listDirectTargetsInCompensationOrder()) {
      try {
        await this.compensateDirectTarget(context, target)
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

    for (const file of compensationScope.listDerivedProvisioningFiles()) {
      if (!terminalBackingResourceIds.has(file.backingResourceId)) {
        continue
      }
      try {
        await this.dependencies.resources.recordCreateCompensatedDerivedResourceDeletion(file.resourceId, context.operationId)
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

  private async compensateDirectTarget(context: CreateCapsuleCompensationContext, target: CreateCapsuleCompensationTarget): Promise<void> {
    if (target.kind === 'instance') {
      await this.compensateInstance(context, target)
      return
    }

    await this.compensateVolume(context, target)
  }

  private async compensateInstance(context: CreateCapsuleCompensationContext, target: CreateCapsuleInstanceCompensationTarget): Promise<void> {
    await this.dependencies.resources.recordBranchResourceDeleteIntent(target.resourceId, context.operationId)

    try {
      await this.dependencies.driver.deleteInstance(context.namespace, target.instanceName)

      await this.dependencies.resources.recordBranchResourceDeleteOutcome(
        target.resourceId,
        context.operationId,
        CapsuleBranchResourceStatus.DELETED,
      )
    } catch (error: unknown) {
      if (this.isNotFound(error)) {
        await this.dependencies.resources.recordBranchResourceDeleteOutcome(
          target.resourceId,
          context.operationId,
          CapsuleBranchResourceStatus.MISSING,
        )
        return
      }

      await this.recordDeleteFailureBestEffort(context.operationId, target, error)
      throw error
    }
  }

  private async compensateVolume(context: CreateCapsuleCompensationContext, target: CreateCapsuleVolumeCompensationTarget): Promise<void> {
    await this.dependencies.resources.recordBranchResourceDeleteIntent(target.resourceId, context.operationId)

    try {
      await this.dependencies.driver.deleteVolume(context.namespace, {
        pool: target.pool,
        volumeName: target.volumeName,
      })

      await this.dependencies.resources.recordBranchResourceDeleteOutcome(
        target.resourceId,
        context.operationId,
        CapsuleBranchResourceStatus.DELETED,
      )
    } catch (error: unknown) {
      if (this.isNotFound(error)) {
        await this.dependencies.resources.recordBranchResourceDeleteOutcome(
          target.resourceId,
          context.operationId,
          CapsuleBranchResourceStatus.MISSING,
        )
        return
      }

      await this.recordDeleteFailureBestEffort(context.operationId, target, error)
      throw error
    }
  }

  private async recordDeleteFailureBestEffort(operationId: string, target: CreateCapsuleCompensationTarget, error: unknown): Promise<void> {
    try {
      await this.dependencies.resources.recordBranchResourceDeleteFailure(target.resourceId, operationId, error, {
        operationId,
        phase: CreateCapsuleFailurePhase.COMPENSATION,
        action: target.kind === 'instance' ? 'compensate_delete_instance' : 'compensate_delete_volume',
        resourceId: target.resourceId,
        resourceKey: target.resourceKey,
      })
    } catch (persistenceError: unknown) {
      console.error(`[CreateCapsuleCompensation] Failed to persist compensation failure for resource '${target.resourceId}'.`, persistenceError)
    }
  }

  private isNotFound(error: unknown): boolean {
    return error instanceof IncusError && error.code === 'NOT_FOUND'
  }
}
