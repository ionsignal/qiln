import { IncusError } from '../../../errors'
import {
  BootstrapFailurePhase,
  createBootstrapCompensationFailureDetail,
  createBootstrapOperationFailureContext,
  type BootstrapCompensationFailureDetail,
} from './failureContext'
import type {
  BootstrapCompensationScope,
  BootstrapCompensationTarget,
  BootstrapInstanceCompensationTarget,
  BootstrapVolumeCompensationTarget,
} from './executionState'
import type { CapsuleResourceDriver } from '../resources/driver'
import type { CapsuleBranchResourceStore } from '../stores'

export interface BootstrapCompensationResult {
  hadFailure: boolean
  failures: BootstrapCompensationFailureDetail[]
}

export interface BootstrapCompensationDependencies {
  resources: CapsuleBranchResourceStore
  driver: CapsuleResourceDriver
}

interface BootstrapCompensationContext {
  operationId: string
  capsuleId: string
  branchId: string
  branchName: string
  namespace: string
}

/**
 * Compensates only direct provider resources for which bootstrap has persisted a successful create outcome.
 *
 * This component performs no aggregate finalization and makes no operation status decision. Those terminal
 * policies remain with the bootstrap coordinator.
 */
export class BootstrapProviderCompensation {
  constructor(private readonly dependencies: BootstrapCompensationDependencies) {}

  public async compensate(context: BootstrapCompensationContext, scope: BootstrapCompensationScope): Promise<BootstrapCompensationResult> {
    const failures: BootstrapCompensationFailureDetail[] = []
    const finalizedBackingResourceIds = new Set<string>()
    for (const target of scope.listDirectTargetsInCompensationOrder()) {
      try {
        await this.compensateDirectTarget(context, target)
        finalizedBackingResourceIds.add(target.resourceId)
      } catch (error: unknown) {
        const action = this.compensationAction(target)
        failures.push(
          createBootstrapCompensationFailureDetail({
            action,
            resourceId: target.resourceId,
            resourceKey: target.resourceKey,
            error,
          }),
        )
        console.error(`[BootstrapProviderCompensation] Failed '${action}' for bootstrap branch '${context.branchName}'.`, error)
      }
    }
    for (const file of scope.listDerivedProvisioningFiles()) {
      if (!finalizedBackingResourceIds.has(file.backingResourceId)) {
        continue
      }
      try {
        await this.dependencies.resources.recordBootstrapCompensatedDerivedResourceDeletion(file.resourceId, context.operationId)
      } catch (error: unknown) {
        failures.push(
          createBootstrapCompensationFailureDetail({
            action: 'compensate_finalize_provisioning_file',
            resourceId: file.resourceId,
            resourceKey: file.resourceKey,
            error,
          }),
        )
        console.error(
          `[BootstrapProviderCompensation] Failed to record derived provisioning-file cleanup for bootstrap branch '${context.branchName}'.`,
          error,
        )
      }
    }
    return {
      hadFailure: failures.length > 0,
      failures,
    }
  }

  private async compensateDirectTarget(context: BootstrapCompensationContext, target: BootstrapCompensationTarget): Promise<void> {
    switch (target.kind) {
      case 'volume':
        await this.compensateVolume(context, target)
        return
      case 'instance':
        await this.compensateInstance(context, target)
        return
    }
  }

  private async compensateVolume(context: BootstrapCompensationContext, target: BootstrapVolumeCompensationTarget): Promise<void> {
    await this.dependencies.resources.recordBranchResourceDeleteIntent(target.resourceId, context.operationId)
    try {
      await this.dependencies.driver.deleteVolume(context.namespace, {
        pool: target.pool,
        volumeName: target.volumeName,
      })
    } catch (error: unknown) {
      if (error instanceof IncusError && error.code === 'NOT_FOUND') {
        await this.dependencies.resources.recordBranchResourceDeleteOutcome(target.resourceId, context.operationId, 'missing')
        return
      }
      await this.dependencies.resources.recordBranchResourceDeleteFailure(
        target.resourceId,
        context.operationId,
        error,
        this.failureContext(context, target, 'compensate_delete_volume'),
      )
      throw error
    }
    await this.dependencies.resources.recordBranchResourceDeleteOutcome(target.resourceId, context.operationId, 'deleted')
  }

  private async compensateInstance(context: BootstrapCompensationContext, target: BootstrapInstanceCompensationTarget): Promise<void> {
    await this.dependencies.resources.recordBranchResourceDeleteIntent(target.resourceId, context.operationId)
    try {
      await this.dependencies.driver.deleteInstance(context.namespace, target.instanceName)
    } catch (error: unknown) {
      if (error instanceof IncusError && error.code === 'NOT_FOUND') {
        await this.dependencies.resources.recordBranchResourceDeleteOutcome(target.resourceId, context.operationId, 'missing')
        return
      }
      await this.dependencies.resources.recordBranchResourceDeleteFailure(
        target.resourceId,
        context.operationId,
        error,
        this.failureContext(context, target, 'compensate_delete_instance'),
      )
      throw error
    }
    await this.dependencies.resources.recordBranchResourceDeleteOutcome(target.resourceId, context.operationId, 'deleted')
  }

  private failureContext(context: BootstrapCompensationContext, target: BootstrapCompensationTarget, action: string): Record<string, unknown> {
    return createBootstrapOperationFailureContext({
      operationId: context.operationId,
      capsuleId: context.capsuleId,
      branchId: context.branchId,
      branchName: context.branchName,
      phase: BootstrapFailurePhase.COMPENSATION,
      action,
      resourceId: target.resourceId,
      resourceKey: target.resourceKey,
    })
  }

  private compensationAction(target: BootstrapCompensationTarget): string {
    return target.kind === 'instance' ? 'compensate_delete_instance' : 'compensate_delete_volume'
  }
}
