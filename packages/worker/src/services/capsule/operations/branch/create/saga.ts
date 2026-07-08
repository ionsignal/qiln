import {
  CapsuleOperationResourceStatus,
  CapsuleOperationStatus,
  type CapsuleBlueprintRegistry,
  type CapsuleBranchCreateOutput,
  type CapsuleOperationResourceStatus as CapsuleOperationResourceStatusValue,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { createBranchCreateRequestHash } from './requestHash'
import type { CapsuleBranchEventPublisher } from '../../../branch/events'
import type { CapsuleOperationLedgerStore } from '../../ledger/store'
import type { OperationResourceInput } from '../../ledger/types'
import type { CapsuleResourceDriver } from '../../../resources/driver'
import type { CapsuleBranchCreatePlanner } from './planner'
import type { CapsuleBranchCreateSagaInput, PlannedOperationResource, PlannedVolumeResource, RollbackCallback } from './types'

export type ResolveCapsuleOwnerNamespace = (ownerId: string) => string

export class CapsuleBranchCreateSaga {
  constructor(
    private readonly store: CapsuleOperationLedgerStore,
    private readonly planner: CapsuleBranchCreatePlanner,
    private readonly driver: CapsuleResourceDriver,
    private readonly events: CapsuleBranchEventPublisher,
    private readonly blueprints: CapsuleBlueprintRegistry,
    private readonly resolveNamespace: ResolveCapsuleOwnerNamespace,
  ) {}

  public async execute(input: CapsuleBranchCreateSagaInput): Promise<CapsuleBranchCreateOutput> {
    const requestHash = createBranchCreateRequestHash({
      name: input.name,
      blueprintName: input.blueprintName,
      blueprintDigest: input.blueprintDigest,
      cpu: input.cpu,
      memory: input.memory,
    })
    const existingReceipt = await this.store.findExistingCreateOperationReceipt(input.ownerId, input.idempotencyKey, requestHash)
    if (existingReceipt) {
      return existingReceipt
    }
    const pin = this.blueprints.pin(input.blueprintName, input.blueprintDigest)
    const accepted = await this.store.acceptCreateOperation({
      ownerId: input.ownerId,
      name: input.name,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      blueprintName: pin.name,
      blueprintDigest: pin.digest,
      blueprintSnapshot: pin.blueprint,
      cpu: input.cpu,
      memory: input.memory,
    })
    if (accepted.replayedReceipt) {
      return accepted.replayedReceipt
    }
    const namespace = this.resolveNamespace(input.ownerId)
    const plan = this.planner.createPlan({
      ownerId: input.ownerId,
      namespace,
      name: input.name,
      cpu: input.cpu,
      memory: input.memory,
      blueprint: pin.blueprint,
    })
    const rollbackStack: RollbackCallback[] = []
    try {
      const projectResourceId = await this.store.createOperationResource(
        this.withOperationContext(plan.project, {
          operationId: accepted.operationId,
          ownerId: input.ownerId,
          branchId: accepted.branchId,
          branchName: input.name,
        }),
      )
      try {
        await this.driver.ensureNamespace(input.ownerId)
        await this.store.transitionResourceStatus(projectResourceId, CapsuleOperationResourceStatus.CREATED)
      } catch (error: unknown) {
        await this.markResourceErrorBestEffort(projectResourceId, error)
        throw error
      }
      this.events.publishStateChanged(input.ownerId, input.name, 'provisioning')
      for (const bindMount of plan.bindMounts) {
        await this.store.createOperationResource(
          this.withOperationContext(bindMount, {
            operationId: accepted.operationId,
            ownerId: input.ownerId,
            branchId: accepted.branchId,
            branchName: input.name,
          }),
        )
      }
      for (const volume of plan.volumes) {
        const resourceId = await this.store.createOperationResource(
          this.withOperationContext(volume, {
            operationId: accepted.operationId,
            ownerId: input.ownerId,
            branchId: accepted.branchId,
            branchName: input.name,
          }),
        )
        rollbackStack.push(() => this.rollbackVolume(namespace, resourceId, volume))
        try {
          await this.driver.createVolume(namespace, volume)
          await this.store.transitionResourceStatus(resourceId, CapsuleOperationResourceStatus.CREATED)
        } catch (error: unknown) {
          await this.markResourceErrorBestEffort(resourceId, error)
          throw error
        }
      }
      const instanceResourceId = await this.store.createOperationResource(
        this.withOperationContext(plan.instance, {
          operationId: accepted.operationId,
          ownerId: input.ownerId,
          branchId: accepted.branchId,
          branchName: input.name,
        }),
      )
      rollbackStack.push(() => this.rollbackInstance(namespace, instanceResourceId, plan.instance.instanceName))
      try {
        await this.driver.createInstance(namespace, plan.instance)
        await this.store.transitionResourceStatus(instanceResourceId, CapsuleOperationResourceStatus.CREATED)
      } catch (error: unknown) {
        await this.markResourceErrorBestEffort(instanceResourceId, error)
        throw error
      }
      for (const file of plan.files) {
        await this.driver.writeProvisioningFile(namespace, input.name, file)
      }
      await this.store.transitionBranchState(input.ownerId, input.name, 'offline')
      this.events.publishStateChanged(input.ownerId, input.name, 'offline')
      await this.store.transitionOperationStatus(accepted.operationId, CapsuleOperationStatus.COMPLETED)
      return this.store.createBranchCreateOutput(accepted.operationId, CapsuleOperationStatus.COMPLETED, input.name, 'offline', false)
    } catch (error: unknown) {
      console.error(`[CapsuleBranchRuntimeService] Provisioning failed for branch '${input.name}'. Initiating rollback...`, error)
      const rollbackHadFailure = await this.rollback(input.name, rollbackStack)
      if (rollbackHadFailure) {
        try {
          await this.store.transitionBranchState(input.ownerId, input.name, 'cleanup_required')
          this.events.publishStateChanged(input.ownerId, input.name, 'cleanup_required')
        } catch (dbErr: unknown) {
          console.error(`[CRITICAL] Failed to mark branch '${input.name}' as cleanup_required:`, dbErr)
        }
        await this.store.markOperationFailure(accepted.operationId, CapsuleOperationStatus.CLEANUP_REQUIRED, error)
        throw error
      }
      try {
        await this.store.deleteBranch(input.ownerId, input.name)
      } catch (dbErr: unknown) {
        console.error(`[CRITICAL] Ghost Record Detected: Failed to remove DB provisioning lock for branch '${input.name}':`, dbErr)
      }
      await this.store.markOperationFailure(accepted.operationId, CapsuleOperationStatus.FAILED, error)
      throw error
    }
  }

  private withOperationContext(
    resource: PlannedOperationResource,
    context: {
      operationId: string
      ownerId: string
      branchId: string
      branchName: string
    },
  ): OperationResourceInput {
    return {
      operationId: context.operationId,
      ownerId: context.ownerId,
      branchId: context.branchId,
      branchName: context.branchName,
      resourceType: resource.resourceType,
      resourceKey: resource.resourceKey,
      cleanupPolicy: resource.cleanupPolicy,
      status: resource.status,
      metadata: resource.metadata,
    }
  }

  private async rollback(branchName: string, rollbackStack: RollbackCallback[]): Promise<boolean> {
    let rollbackHadFailure = false
    while (rollbackStack.length > 0) {
      const rollbackFn = rollbackStack.pop()
      if (!rollbackFn) {
        continue
      }
      try {
        await rollbackFn()
      } catch (rollbackErr: unknown) {
        rollbackHadFailure = true
        if (rollbackErr instanceof IncusError && rollbackErr.code === 'NOT_FOUND') {
          continue
        }
        console.error(`[CRITICAL] Zombie Resource Detected: Failed during rollback for branch '${branchName}':`, rollbackErr)
      }
    }
    return rollbackHadFailure
  }

  private async rollbackVolume(namespace: string, resourceId: string, volume: PlannedVolumeResource): Promise<void> {
    await this.transitionResourceStatusBestEffort(resourceId, CapsuleOperationResourceStatus.DELETING)
    try {
      await this.driver.deleteVolume(namespace, volume)
      await this.transitionResourceStatusBestEffort(resourceId, CapsuleOperationResourceStatus.DELETED)
    } catch (rollbackErr: unknown) {
      if (rollbackErr instanceof IncusError && rollbackErr.code === 'NOT_FOUND') {
        await this.transitionResourceStatusBestEffort(resourceId, CapsuleOperationResourceStatus.MISSING)
        return
      }
      await this.markResourceErrorBestEffort(resourceId, rollbackErr)
      throw rollbackErr
    }
  }

  private async rollbackInstance(namespace: string, resourceId: string, instanceName: string): Promise<void> {
    await this.transitionResourceStatusBestEffort(resourceId, CapsuleOperationResourceStatus.DELETING)
    try {
      await this.driver.deleteInstance(namespace, instanceName)
      await this.transitionResourceStatusBestEffort(resourceId, CapsuleOperationResourceStatus.DELETED)
    } catch (rollbackErr: unknown) {
      if (rollbackErr instanceof IncusError && rollbackErr.code === 'NOT_FOUND') {
        await this.transitionResourceStatusBestEffort(resourceId, CapsuleOperationResourceStatus.MISSING)
        return
      }
      await this.markResourceErrorBestEffort(resourceId, rollbackErr)
      throw rollbackErr
    }
  }

  private async transitionResourceStatusBestEffort(resourceId: string, status: CapsuleOperationResourceStatusValue): Promise<void> {
    try {
      await this.store.transitionResourceStatus(resourceId, status)
    } catch (error: unknown) {
      console.error(`[CapsuleBranchRuntimeService] Failed to mark resource '${resourceId}' as '${status}' during rollback.`, error)
    }
  }

  private async markResourceErrorBestEffort(resourceId: string, error: unknown): Promise<void> {
    try {
      await this.store.markResourceError(resourceId, error)
    } catch (dbError: unknown) {
      console.error(`[CapsuleBranchRuntimeService] Failed to persist resource error for '${resourceId}'.`, dbError)
    }
  }
}
