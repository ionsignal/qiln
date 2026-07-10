import {
  CapsuleBranchOperationRequestHashSchema,
  CapsuleBranchOperationStatus,
  CapsuleBranchResourceStatus,
  digestCanonicalJsonValue,
  type CapsuleBlueprintDigest,
  type CapsuleBlueprintRegistry,
  type CapsuleBranchCreateOutput,
  type CapsuleBranchOperationRequestHash,
  type CapsuleBranchOperationStatusValue,
  type CapsuleBranchResourceStatusValue,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { InlineOperationStepExecutor } from '../../inlineStepExecutor'
import {
  CapsuleBranchCreateFailurePhase,
  CapsuleCompensationStatus,
  createCompensationFailureDetail,
  createOperationFailureContext,
  type CapsuleCompensationResult,
} from '../../errors'
import { CapsuleBranchCreateStepKey } from './steps'
import { createCapsuleBranchResourceInventoryDigest, type CapsuleBranchResourceInventoryEntry } from '../../../resources/inventory'
import type { CapsuleBranchEventPublisher } from '../../../branch/events'
import type {
  BranchResourceInput,
  CapsuleBranchOperationStepStore,
  CapsuleBranchOperationStore,
  CapsuleBranchResourceStore,
  CapsuleBranchStore,
} from '../../../stores'
import type { CapsuleResourceDriver } from '../../../resources/driver'
import type { CapsuleBranchCreatePlanner } from './planner'
import type { CapsuleBranchCreateResourcePlan, CapsuleBranchCreateOperationInput, PlannedBranchResource, PlannedVolumeResource } from './types'

export type ResolveCapsuleOwnerNamespace = (ownerId: string) => string

export interface CapsuleBranchCreateOperationStores {
  branches: CapsuleBranchStore
  operations: CapsuleBranchOperationStore
  steps: CapsuleBranchOperationStepStore
  resources: CapsuleBranchResourceStore
}

interface BranchCreateRequestHashInput {
  name: string
  blueprintName: string
  blueprintDigest: CapsuleBlueprintDigest
  cpu: string
  memory: string
}

interface BranchCreateCompensationTask {
  action: string
  resourceId: string
  resourceKey: string
  run: () => Promise<void>
}

function createExpectedBranchResourceInventoryEntries(plan: CapsuleBranchCreateResourcePlan): CapsuleBranchResourceInventoryEntry[] {
  return [plan.project, ...plan.bindMounts, ...plan.volumes, plan.instance, ...plan.files].map(resource => ({
    provider: 'incus',
    resourceType: resource.resourceType,
    resourceKey: resource.resourceKey,
    cleanupPolicy: resource.cleanupPolicy,
    metadata: resource.metadata,
  }))
}

function createBranchCreateRequestHash(input: BranchCreateRequestHashInput): CapsuleBranchOperationRequestHash {
  const digest = digestCanonicalJsonValue(input, {
    context: 'capsule branch create request',
  })
  return CapsuleBranchOperationRequestHashSchema.parse(digest)
}

export class CapsuleBranchProvisioningOperation {
  private readonly stepExecutor: InlineOperationStepExecutor

  constructor(
    private readonly stores: CapsuleBranchCreateOperationStores,
    private readonly planner: CapsuleBranchCreatePlanner,
    private readonly driver: CapsuleResourceDriver,
    private readonly events: CapsuleBranchEventPublisher,
    private readonly blueprints: CapsuleBlueprintRegistry,
    private readonly resolveNamespace: ResolveCapsuleOwnerNamespace,
  ) {
    this.stepExecutor = new InlineOperationStepExecutor(this.stores.steps)
  }

  public async execute(input: CapsuleBranchCreateOperationInput): Promise<CapsuleBranchCreateOutput> {
    const requestHash = createBranchCreateRequestHash({
      name: input.name,
      blueprintName: input.blueprintName,
      blueprintDigest: input.blueprintDigest,
      cpu: input.cpu,
      memory: input.memory,
    })
    const existingReceipt = await this.stores.operations.findExistingBranchCreateOperationReceipt(
      input.ownerId,
      input.idempotencyKey,
      requestHash,
    )
    if (existingReceipt) {
      return existingReceipt
    }
    const pin = this.blueprints.pin(input.blueprintName, input.blueprintDigest)
    const accepted = await this.stores.operations.acceptBranchCreateOperation({
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
    const operationContext = {
      operationId: accepted.operationId,
      ownerId: input.ownerId,
      branchId: accepted.branchId,
      branchName: input.name,
    }
    const resourceContext = {
      operationId: accepted.operationId,
      ownerId: input.ownerId,
      branchId: accepted.branchId,
      branchName: input.name,
    }
    const compensationStack: BranchCreateCompensationTask[] = []
    let currentPhase: CapsuleBranchCreateFailurePhase = CapsuleBranchCreateFailurePhase.PLAN_RESOURCES
    let currentStepKey: CapsuleBranchCreateStepKey | null = null
    let branchFinalized = false
    const runStep = async <TResult>(
      stepKey: CapsuleBranchCreateStepKey,
      metadata: Record<string, unknown>,
      action: () => Promise<TResult> | TResult,
    ): Promise<TResult> => {
      currentPhase = stepKey
      currentStepKey = stepKey
      return await this.stepExecutor.run(
        {
          ...operationContext,
          stepKey,
          metadata,
        },
        action,
      )
    }
    try {
      const plan = await runStep(
        CapsuleBranchCreateStepKey.PLAN_RESOURCES,
        {
          blueprintName: pin.name,
          blueprintDigest: pin.digest,
          volumeDefinitionCount: pin.blueprint.provisioning.volumes.length,
          bindMountDefinitionCount: pin.blueprint.provisioning.volumes.filter(volume => volume.type === 'bind').length,
          provisioningFileDefinitionCount: pin.blueprint.provisioning.files.length,
        },
        () =>
          this.planner.createPlan({
            ownerId: input.ownerId,
            namespace,
            name: input.name,
            cpu: input.cpu,
            memory: input.memory,
            blueprint: pin.blueprint,
          }),
      )
      const expectedInventoryEntries = createExpectedBranchResourceInventoryEntries(plan)
      await runStep(
        CapsuleBranchCreateStepKey.RECORD_RESOURCE_INVENTORY,
        {
          resourceCount: expectedInventoryEntries.length,
        },
        async () => {
          const resourceInventoryDigest = createCapsuleBranchResourceInventoryDigest(
            expectedInventoryEntries,
            'capsule branch planned resource inventory',
          )
          await this.stores.branches.recordBranchResourceInventoryDigest(input.ownerId, input.name, resourceInventoryDigest)
        },
      )
      await runStep(
        CapsuleBranchCreateStepKey.ENSURE_NAMESPACE,
        {
          namespace,
          resourceKey: plan.project.resourceKey,
        },
        async () => {
          const projectResourceId = await this.stores.resources.ensureBranchResource(this.withOperationContext(plan.project, resourceContext))
          try {
            await this.driver.ensureNamespace(input.ownerId)
            await this.stores.resources.transitionBranchResourceStatus(projectResourceId, CapsuleBranchResourceStatus.CREATED)
          } catch (error: unknown) {
            await this.markResourceErrorBestEffort(
              projectResourceId,
              error,
              createOperationFailureContext({
                operationId: accepted.operationId,
                branchName: input.name,
                phase: currentPhase,
                stepKey: currentStepKey,
                action: 'ensure_namespace',
                resourceId: projectResourceId,
                resourceKey: plan.project.resourceKey,
              }),
            )
            throw error
          }
        },
      )
      this.events.publishStateChanged(input.ownerId, input.name, 'provisioning')
      await runStep(
        CapsuleBranchCreateStepKey.RECORD_BIND_MOUNTS,
        {
          count: plan.bindMounts.length,
        },
        async () => {
          for (const bindMount of plan.bindMounts) {
            await this.stores.resources.ensureBranchResource(this.withOperationContext(bindMount, resourceContext))
          }
        },
      )
      await runStep(
        CapsuleBranchCreateStepKey.CREATE_VOLUMES,
        {
          count: plan.volumes.length,
        },
        async () => {
          for (const volume of plan.volumes) {
            const resourceId = await this.stores.resources.ensureBranchResource(this.withOperationContext(volume, resourceContext))
            compensationStack.push({
              action: 'compensate_delete_volume',
              resourceId,
              resourceKey: volume.resourceKey,
              run: () =>
                this.compensateVolume(
                  namespace,
                  resourceId,
                  volume,
                  createOperationFailureContext({
                    operationId: accepted.operationId,
                    branchName: input.name,
                    phase: CapsuleBranchCreateFailurePhase.COMPENSATION,
                    action: 'compensate_delete_volume',
                    resourceId,
                    resourceKey: volume.resourceKey,
                  }),
                ),
            })
            try {
              await this.driver.createVolume(namespace, volume)
              await this.stores.resources.transitionBranchResourceStatus(resourceId, CapsuleBranchResourceStatus.CREATED)
            } catch (error: unknown) {
              await this.markResourceErrorBestEffort(
                resourceId,
                error,
                createOperationFailureContext({
                  operationId: accepted.operationId,
                  branchName: input.name,
                  phase: currentPhase,
                  stepKey: currentStepKey,
                  action: volume.volumeType === 'clone' ? 'clone_volume' : 'create_volume',
                  resourceId,
                  resourceKey: volume.resourceKey,
                }),
              )
              throw error
            }
          }
        },
      )
      await runStep(
        CapsuleBranchCreateStepKey.CREATE_INSTANCE,
        {
          instanceName: plan.instance.instanceName,
          imageAlias: plan.instance.imageAlias,
          resourceKey: plan.instance.resourceKey,
        },
        async () => {
          const instanceResourceId = await this.stores.resources.ensureBranchResource(this.withOperationContext(plan.instance, resourceContext))
          compensationStack.push({
            action: 'compensate_delete_instance',
            resourceId: instanceResourceId,
            resourceKey: plan.instance.resourceKey,
            run: () =>
              this.compensateInstance(
                namespace,
                instanceResourceId,
                plan.instance.instanceName,
                createOperationFailureContext({
                  operationId: accepted.operationId,
                  branchName: input.name,
                  phase: CapsuleBranchCreateFailurePhase.COMPENSATION,
                  action: 'compensate_delete_instance',
                  resourceId: instanceResourceId,
                  resourceKey: plan.instance.resourceKey,
                }),
              ),
          })
          try {
            await this.driver.createInstance(namespace, plan.instance)
            await this.stores.resources.transitionBranchResourceStatus(instanceResourceId, CapsuleBranchResourceStatus.CREATED)
          } catch (error: unknown) {
            await this.markResourceErrorBestEffort(
              instanceResourceId,
              error,
              createOperationFailureContext({
                operationId: accepted.operationId,
                branchName: input.name,
                phase: currentPhase,
                stepKey: currentStepKey,
                action: 'create_instance',
                resourceId: instanceResourceId,
                resourceKey: plan.instance.resourceKey,
              }),
            )
            throw error
          }
        },
      )
      await runStep(
        CapsuleBranchCreateStepKey.WRITE_PROVISIONING_FILES,
        {
          count: plan.files.length,
        },
        async () => {
          for (const file of plan.files) {
            const resourceId = await this.stores.resources.ensureBranchResource(this.withOperationContext(file, resourceContext))
            try {
              await this.stores.resources.transitionBranchResourceStatus(resourceId, CapsuleBranchResourceStatus.CREATING)
              await this.driver.writeProvisioningFile(namespace, input.name, file)
              await this.stores.resources.transitionBranchResourceStatus(resourceId, CapsuleBranchResourceStatus.CREATED)
            } catch (error: unknown) {
              await this.markResourceErrorBestEffort(
                resourceId,
                error,
                createOperationFailureContext({
                  operationId: accepted.operationId,
                  branchName: input.name,
                  phase: currentPhase,
                  stepKey: currentStepKey,
                  action: 'write_provisioning_file',
                  resourceId,
                  resourceKey: file.resourceKey,
                }),
              )
              throw error
            }
          }
        },
      )
      await runStep(
        CapsuleBranchCreateStepKey.FINALIZE_BRANCH_OFFLINE,
        {
          status: 'offline',
        },
        async () => {
          await this.stores.branches.transitionBranchState(input.ownerId, input.name, 'offline')
          this.events.publishStateChanged(input.ownerId, input.name, 'offline')
          branchFinalized = true
        },
      )
      currentPhase = CapsuleBranchCreateFailurePhase.COMPLETE_OPERATION
      currentStepKey = null
      await this.stores.operations.transitionBranchOperationStatus(accepted.operationId, CapsuleBranchOperationStatus.COMPLETED)
      return this.stores.operations.createBranchCreateOutput(
        accepted.operationId,
        CapsuleBranchOperationStatus.COMPLETED,
        input.name,
        'offline',
        false,
      )
    } catch (error: unknown) {
      if (branchFinalized) {
        console.error(
          `[CapsuleBranchRuntimeService] Branch '${input.name}' finalized but operation failed during '${currentPhase}'. Leaving branch resources intact for cleanup visibility.`,
          error,
        )
        await this.markOperationFailureBestEffort(
          accepted.operationId,
          CapsuleBranchOperationStatus.FAILED,
          error,
          createOperationFailureContext({
            operationId: accepted.operationId,
            branchName: input.name,
            phase: currentPhase,
            stepKey: currentStepKey,
            branchFinalized,
            action: currentPhase === CapsuleBranchCreateFailurePhase.COMPLETE_OPERATION ? 'mark_operation_completed' : undefined,
            compensationStatus: CapsuleCompensationStatus.SKIPPED,
          }),
        )
        throw error
      }
      console.error(`[CapsuleBranchRuntimeService] Provisioning failed for branch '${input.name}'. Initiating compensation cleanup...`, error)
      const compensationResult = await this.compensate(input.name, compensationStack)
      if (compensationResult.hadFailure) {
        try {
          await this.stores.branches.transitionBranchState(input.ownerId, input.name, 'cleanup_required')
          this.events.publishStateChanged(input.ownerId, input.name, 'cleanup_required')
        } catch (dbErr: unknown) {
          console.error(`[CRITICAL] Failed to mark branch '${input.name}' as cleanup_required:`, dbErr)
        }
        await this.stores.operations.markBranchOperationFailure(
          accepted.operationId,
          CapsuleBranchOperationStatus.CLEANUP_REQUIRED,
          error,
          createOperationFailureContext({
            operationId: accepted.operationId,
            branchName: input.name,
            phase: currentPhase,
            stepKey: currentStepKey,
            branchFinalized,
            compensationStatus: CapsuleCompensationStatus.FAILED,
            compensationFailures: compensationResult.failures,
          }),
        )
        throw error
      }
      try {
        await this.stores.branches.deleteBranch(input.ownerId, input.name)
        this.events.publishDeleted(input.ownerId, input.name)
      } catch (dbErr: unknown) {
        console.error(`[CRITICAL] Ghost Record Detected: Failed to remove DB provisioning lock for branch '${input.name}':`, dbErr)
      }
      await this.stores.operations.markBranchOperationFailure(
        accepted.operationId,
        CapsuleBranchOperationStatus.FAILED,
        error,
        createOperationFailureContext({
          operationId: accepted.operationId,
          branchName: input.name,
          phase: currentPhase,
          stepKey: currentStepKey,
          branchFinalized,
          compensationStatus: CapsuleCompensationStatus.COMPLETED,
        }),
      )
      throw error
    }
  }

  private withOperationContext(
    resource: PlannedBranchResource,
    context: {
      operationId: string
      ownerId: string
      branchId: string
      branchName: string
    },
  ): BranchResourceInput {
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

  private async compensate(branchName: string, compensationStack: BranchCreateCompensationTask[]): Promise<CapsuleCompensationResult> {
    const failures: CapsuleCompensationResult['failures'] = []
    while (compensationStack.length > 0) {
      const compensationTask = compensationStack.pop()
      if (!compensationTask) {
        continue
      }
      try {
        await compensationTask.run()
      } catch (compensationErr: unknown) {
        if (compensationErr instanceof IncusError && compensationErr.code === 'NOT_FOUND') {
          continue
        }
        failures.push(
          createCompensationFailureDetail({
            action: compensationTask.action,
            resourceId: compensationTask.resourceId,
            resourceKey: compensationTask.resourceKey,
            error: compensationErr,
          }),
        )
        console.error(`[CRITICAL] Orphaned Resource Detected: Failed during compensation cleanup for branch '${branchName}':`, compensationErr)
      }
    }
    return {
      hadFailure: failures.length > 0,
      failures,
    }
  }

  private async compensateVolume(
    namespace: string,
    resourceId: string,
    volume: PlannedVolumeResource,
    failureContext: Record<string, unknown>,
  ): Promise<void> {
    await this.transitionResourceStatusBestEffort(resourceId, CapsuleBranchResourceStatus.DELETING)
    try {
      await this.driver.deleteVolume(namespace, volume)
      await this.transitionResourceStatusBestEffort(resourceId, CapsuleBranchResourceStatus.DELETED)
    } catch (compensationErr: unknown) {
      if (compensationErr instanceof IncusError && compensationErr.code === 'NOT_FOUND') {
        await this.transitionResourceStatusBestEffort(resourceId, CapsuleBranchResourceStatus.MISSING)
        return
      }
      await this.markResourceErrorBestEffort(resourceId, compensationErr, failureContext)
      throw compensationErr
    }
  }

  private async compensateInstance(
    namespace: string,
    resourceId: string,
    instanceName: string,
    failureContext: Record<string, unknown>,
  ): Promise<void> {
    await this.transitionResourceStatusBestEffort(resourceId, CapsuleBranchResourceStatus.DELETING)
    try {
      await this.driver.deleteInstance(namespace, instanceName)
      await this.transitionResourceStatusBestEffort(resourceId, CapsuleBranchResourceStatus.DELETED)
    } catch (compensationErr: unknown) {
      if (compensationErr instanceof IncusError && compensationErr.code === 'NOT_FOUND') {
        await this.transitionResourceStatusBestEffort(resourceId, CapsuleBranchResourceStatus.MISSING)
        return
      }
      await this.markResourceErrorBestEffort(resourceId, compensationErr, failureContext)
      throw compensationErr
    }
  }

  private async transitionResourceStatusBestEffort(resourceId: string, status: CapsuleBranchResourceStatusValue): Promise<void> {
    try {
      await this.stores.resources.transitionBranchResourceStatus(resourceId, status)
    } catch (error: unknown) {
      console.error(`[CapsuleBranchRuntimeService] Failed to mark resource '${resourceId}' as '${status}' during compensation cleanup.`, error)
    }
  }

  private async markResourceErrorBestEffort(resourceId: string, error: unknown, context?: Record<string, unknown>): Promise<void> {
    try {
      await this.stores.resources.markBranchResourceError(resourceId, error, context)
    } catch (dbError: unknown) {
      console.error(`[CapsuleBranchRuntimeService] Failed to persist resource error for '${resourceId}'.`, dbError)
    }
  }

  private async markOperationFailureBestEffort(
    operationId: string,
    status: CapsuleBranchOperationStatusValue,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.stores.operations.markBranchOperationFailure(operationId, status, error, context)
    } catch (dbError: unknown) {
      console.error(`[CapsuleBranchRuntimeService] Failed to persist operation failure for '${operationId}'.`, dbError)
    }
  }
}
