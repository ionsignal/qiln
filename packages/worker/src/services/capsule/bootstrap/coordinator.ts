import {
  CapsuleLifecycleOperationRequestHashSchema,
  CapsuleLifecycleOperationStatus,
  digestCanonicalJsonValue,
  type CapsuleBlueprintDigest,
  type CapsuleBlueprintRegistry,
  type CapsuleBootstrapCreateOutput,
  type CapsuleLifecycleOperationRequestHash,
  type CapsuleLifecycleOperationStatusValue,
} from '@qiln/core/server'
import { InlineLifecycleStepExecutor } from '../lifecycleLedger/executor'
import {
  BootstrapCompensatedBranchRemovalStatus,
  BootstrapCompensationStatus,
  BootstrapFailurePhase,
  createBootstrapCompensatedBranchRemovalFailureDetail,
  createBootstrapOperationFailureContext,
} from './failureContext'
import { BootstrapExecutionState } from './executionState'
import { BootstrapProviderCompensation } from './compensation'
import { BootstrapStepKey } from './stepKeys'
import { BootstrapPreparationPhase } from './phases/prepare'
import { BootstrapResourceMutationPhase } from './phases/resources'
import { BootstrapProvisioningFilePhase } from './phases/provisioningFiles'
import { BootstrapFinalizationPhase } from './phases/finalize'
import type { CapsuleBranchEventPublisher } from '../branch/events'
import type {
  CapsuleBranchResourceStore,
  CapsuleBranchStore,
  CapsuleLifecycleOperationStepStore,
  CapsuleLifecycleOperationStore,
} from '../stores'
import type { CapsuleResourceDriver } from '../resources/driver'
import type { BootstrapResourcePlanner } from './planner'
import type { BootstrapOperationContext, BootstrapProvisioningInput, BootstrapResourcePlan } from './types'

export type ResolveCapsuleOwnerNamespace = (ownerId: string) => string

export interface BootstrapProvisioningStores {
  branches: CapsuleBranchStore
  operations: CapsuleLifecycleOperationStore
  steps: CapsuleLifecycleOperationStepStore
  resources: CapsuleBranchResourceStore
}

interface BootstrapRequestHashInput {
  operationType: 'bootstrap'
  bootstrapBranchName: string
  blueprintName: string
  blueprintDigest: CapsuleBlueprintDigest
  cpu: string
  memory: string
}

function createBootstrapRequestHash(input: Omit<BootstrapRequestHashInput, 'operationType'>): CapsuleLifecycleOperationRequestHash {
  const digest = digestCanonicalJsonValue(
    {
      operationType: 'bootstrap',
      ...input,
    } satisfies BootstrapRequestHashInput,
    {
      context: 'capsule bootstrap request',
    },
  )

  return CapsuleLifecycleOperationRequestHashSchema.parse(digest)
}

/**
 * Coordinates the root mutation that creates a capsule aggregate and provisions
 * its first editable branch.
 *
 * Durable rows are a fail-closed accounting ledger, not a resumable operation
 * runner. Bootstrap compensation and terminal policy remain specific to this
 * coordinator.
 */
export class BootstrapProvisioningCoordinator {
  private readonly stepExecutor: InlineLifecycleStepExecutor
  private readonly preparation: BootstrapPreparationPhase
  private readonly resourceMutation: BootstrapResourceMutationPhase
  private readonly provisioningFiles: BootstrapProvisioningFilePhase
  private readonly finalization: BootstrapFinalizationPhase
  private readonly compensation: BootstrapProviderCompensation

  constructor(
    private readonly stores: BootstrapProvisioningStores,
    planner: BootstrapResourcePlanner,
    driver: CapsuleResourceDriver,
    private readonly events: CapsuleBranchEventPublisher,
    private readonly blueprints: CapsuleBlueprintRegistry,
    private readonly resolveNamespace: ResolveCapsuleOwnerNamespace,
  ) {
    this.stepExecutor = new InlineLifecycleStepExecutor(stores.steps)
    this.preparation = new BootstrapPreparationPhase(planner, stores.branches)
    this.resourceMutation = new BootstrapResourceMutationPhase({
      driver,
      resources: stores.resources,
    })
    this.provisioningFiles = new BootstrapProvisioningFilePhase({
      driver,
      resources: stores.resources,
    })
    this.finalization = new BootstrapFinalizationPhase(stores.operations, events)
    this.compensation = new BootstrapProviderCompensation({
      driver,
      resources: stores.resources,
    })
  }

  public async execute(input: BootstrapProvisioningInput): Promise<CapsuleBootstrapCreateOutput> {
    const requestHash = createBootstrapRequestHash({
      bootstrapBranchName: input.bootstrapBranchName,
      blueprintName: input.blueprintName,
      blueprintDigest: input.blueprintDigest,
      cpu: input.cpu,
      memory: input.memory,
    })

    const existingReceipt = await this.stores.operations.findExistingBootstrapOperationReceipt(input.ownerId, input.idempotencyKey, requestHash)

    if (existingReceipt) {
      return existingReceipt
    }

    const pin = this.blueprints.pin(input.blueprintName, input.blueprintDigest)

    const accepted = await this.stores.operations.acceptBootstrapOperation({
      ownerId: input.ownerId,
      bootstrapBranchName: input.bootstrapBranchName,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      blueprintName: pin.name,
      blueprintDigest: pin.digest,
      blueprintSnapshot: pin.blueprint,
      cpu: input.cpu,
      memory: input.memory,
    })

    if ('replayedReceipt' in accepted) {
      return accepted.replayedReceipt
    }

    const context: BootstrapOperationContext = {
      operationId: accepted.operationId,
      capsuleId: accepted.capsuleId,
      ownerId: input.ownerId,
      branchId: accepted.branchId,
      branchName: input.bootstrapBranchName,
      namespace: this.resolveNamespace(input.ownerId),
    }

    const state = new BootstrapExecutionState(BootstrapFailurePhase.PLAN_RESOURCES)

    const runStep = async <TResult>(
      stepKey: BootstrapStepKey,
      metadata: Record<string, unknown>,
      action: () => Promise<TResult> | TResult,
    ): Promise<TResult> => {
      state.beginStep(stepKey)

      return await this.stepExecutor.run(
        {
          operationId: context.operationId,
          capsuleId: context.capsuleId,
          ownerId: context.ownerId,
          branchId: context.branchId,
          branchName: context.branchName,
          stepKey,
          metadata,
        },
        action,
      )
    }

    try {
      const plan = await runStep(
        BootstrapStepKey.PLAN_RESOURCES,
        {
          blueprintName: pin.name,
          blueprintDigest: pin.digest,
          volumeDefinitionCount: pin.blueprint.provisioning.volumes.length,
          bindMountDefinitionCount: pin.blueprint.provisioning.volumes.filter(volume => volume.type === 'bind').length,
          provisioningFileDefinitionCount: pin.blueprint.provisioning.files.length,
        },
        () =>
          this.preparation.createResourcePlan({
            ownerId: input.ownerId,
            namespace: context.namespace,
            bootstrapBranchName: input.bootstrapBranchName,
            cpu: input.cpu,
            memory: input.memory,
            blueprint: pin.blueprint,
          }),
      )

      await runStep(
        BootstrapStepKey.RECORD_RESOURCE_INVENTORY,
        {
          resourceCount: this.resourceCount(plan),
        },
        () => this.preparation.recordResourceInventory(context.ownerId, context.branchId, plan),
      )

      await runStep(
        BootstrapStepKey.ENSURE_NAMESPACE,
        {
          namespace: context.namespace,
          resourceKey: plan.project.resourceKey,
        },
        () => this.resourceMutation.ensureNamespace(context, plan.project),
      )

      this.events.publishStateChanged(context.ownerId, context.capsuleId, context.branchName, 'provisioning')

      await runStep(
        BootstrapStepKey.RECORD_BIND_MOUNTS,
        {
          count: plan.bindMounts.length,
        },
        () => this.resourceMutation.recordBindMounts(context, plan.bindMounts),
      )

      await runStep(
        BootstrapStepKey.CREATE_VOLUMES,
        {
          count: plan.volumes.length,
        },
        () => this.resourceMutation.createVolumes(context, plan.volumes, state),
      )

      await runStep(
        BootstrapStepKey.CREATE_INSTANCE,
        {
          instanceName: plan.instance.instanceName,
          imageAlias: plan.instance.imageAlias,
          resourceKey: plan.instance.resourceKey,
        },
        () => this.resourceMutation.createInstance(context, plan.instance, state),
      )

      await runStep(
        BootstrapStepKey.WRITE_PROVISIONING_FILES,
        {
          count: plan.files.length,
        },
        () => this.provisioningFiles.writeFiles(context, plan.files, state),
      )

      await runStep(
        BootstrapStepKey.FINALIZE_BRANCH_OFFLINE,
        {
          capsuleStatus: 'active',
          branchStatus: 'offline',
        },
        () => this.finalization.finalizeCapsuleActive(context, state),
      )

      state.beginTerminalPhase(BootstrapFailurePhase.COMPLETE_OPERATION)

      await this.stores.operations.transitionLifecycleOperationStatus(context.operationId, CapsuleLifecycleOperationStatus.COMPLETED)

      return this.stores.operations.createBootstrapOutput(
        context.operationId,
        context.capsuleId,
        CapsuleLifecycleOperationStatus.COMPLETED,
        context.branchName,
        'offline',
        false,
      )
    } catch (error: unknown) {
      await this.resolveFailure(context, state, error)
      throw error
    }
  }

  private async resolveFailure(context: BootstrapOperationContext, state: BootstrapExecutionState, error: unknown): Promise<void> {
    if (state.branchFinalizedOffline) {
      console.error(
        `[BootstrapProvisioningCoordinator] Capsule '${context.capsuleId}' finalized active with offline root branch '${context.branchName}', but its bootstrap operation failed during '${state.currentFailurePhase}'. Preserving the usable runtime for inspection.`,
        error,
      )

      await this.markOperationFailureBestEffort(
        context.operationId,
        CapsuleLifecycleOperationStatus.FAILED,
        error,
        createBootstrapOperationFailureContext({
          operationId: context.operationId,
          capsuleId: context.capsuleId,
          branchId: context.branchId,
          branchName: context.branchName,
          phase: state.currentFailurePhase,
          stepKey: state.currentStepKey,
          branchFinalized: true,
          aggregateFinalized: true,
          action: state.currentFailurePhase === BootstrapFailurePhase.COMPLETE_OPERATION ? 'mark_bootstrap_operation_completed' : undefined,
          compensationStatus: BootstrapCompensationStatus.SKIPPED,
          compensatedBranchRemovalStatus: BootstrapCompensatedBranchRemovalStatus.NOT_ATTEMPTED,
        }),
      )
      return
    }

    console.error(
      `[BootstrapProvisioningCoordinator] Provisioning failed for capsule '${context.capsuleId}' root branch '${context.branchName}'. Initiating proven bootstrap compensation.`,
      error,
    )

    const compensationResult = await this.compensation.compensate(
      {
        operationId: context.operationId,
        capsuleId: context.capsuleId,
        branchId: context.branchId,
        branchName: context.branchName,
        namespace: context.namespace,
      },
      state.compensation,
    )

    if (state.directProviderOwnershipUncertain || compensationResult.hadFailure) {
      await this.markAggregateCleanupRequiredBestEffort(
        context,
        error,
        createBootstrapOperationFailureContext({
          operationId: context.operationId,
          capsuleId: context.capsuleId,
          branchId: context.branchId,
          branchName: context.branchName,
          phase: state.currentFailurePhase,
          stepKey: state.currentStepKey,
          branchFinalized: false,
          aggregateFinalized: false,
          resourceOwnershipUncertain: state.directProviderOwnershipUncertain || undefined,
          compensationStatus: compensationResult.hadFailure ? BootstrapCompensationStatus.FAILED : BootstrapCompensationStatus.COMPLETED,
          compensationFailures: compensationResult.failures,
          compensatedBranchRemovalStatus: BootstrapCompensatedBranchRemovalStatus.NOT_ATTEMPTED,
        }),
      )
      return
    }

    state.beginTerminalPhase(BootstrapFailurePhase.FINALIZE_COMPENSATED_BOOTSTRAP)

    try {
      await this.stores.operations.finalizeCompensatedBootstrapFailure({
        ownerId: context.ownerId,
        capsuleId: context.capsuleId,
        operationId: context.operationId,
        branchId: context.branchId,
        error,
        failureContext: createBootstrapOperationFailureContext({
          operationId: context.operationId,
          capsuleId: context.capsuleId,
          branchId: context.branchId,
          branchName: context.branchName,
          phase: state.currentFailurePhase,
          branchFinalized: false,
          aggregateFinalized: false,
          action: 'finalize_compensated_bootstrap_failure',
          compensationStatus: BootstrapCompensationStatus.COMPLETED,
          compensatedBranchRemovalStatus: BootstrapCompensatedBranchRemovalStatus.COMPLETED,
        }),
      })
    } catch (finalizationError: unknown) {
      const finalizationFailure = createBootstrapCompensatedBranchRemovalFailureDetail({
        action: 'finalize_compensated_bootstrap_failure',
        branchId: context.branchId,
        error: finalizationError,
      })

      console.error(
        `[BootstrapProvisioningCoordinator] Provider compensation completed, but capsule '${context.capsuleId}' could not be finalized as creation_failed.`,
        finalizationError,
      )

      await this.markAggregateCleanupRequiredBestEffort(
        context,
        error,
        createBootstrapOperationFailureContext({
          operationId: context.operationId,
          capsuleId: context.capsuleId,
          branchId: context.branchId,
          branchName: context.branchName,
          phase: state.currentFailurePhase,
          branchFinalized: false,
          aggregateFinalized: false,
          action: 'mark_compensated_bootstrap_cleanup_required',
          compensationStatus: BootstrapCompensationStatus.COMPLETED,
          compensatedBranchRemovalStatus: BootstrapCompensatedBranchRemovalStatus.FAILED,
          compensatedBranchRemovalFailure: finalizationFailure,
        }),
      )
    }
  }

  private resourceCount(plan: BootstrapResourcePlan): number {
    return 1 + plan.bindMounts.length + plan.volumes.length + 1 + plan.files.length
  }

  private async markAggregateCleanupRequiredBestEffort(
    context: BootstrapOperationContext,
    error: unknown,
    failureContext: Record<string, unknown>,
  ): Promise<void> {
    try {
      const marked = await this.stores.operations.markLifecycleOperationAndAggregateCleanupRequired(
        context.ownerId,
        context.capsuleId,
        context.operationId,
        error,
        failureContext,
      )

      if (marked) {
        this.events.publishStateChanged(context.ownerId, context.capsuleId, context.branchName, 'cleanup_required')
      }
    } catch (databaseError: unknown) {
      console.error(`[BootstrapProvisioningCoordinator] Failed to mark capsule '${context.capsuleId}' cleanup_required.`, databaseError)
    }
  }

  private async markOperationFailureBestEffort(
    operationId: string,
    status: CapsuleLifecycleOperationStatusValue,
    error: unknown,
    failureContext: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.stores.operations.markLifecycleOperationFailure(operationId, status, error, failureContext)
    } catch (databaseError: unknown) {
      console.error(`[BootstrapProvisioningCoordinator] Failed to persist lifecycle operation failure for '${operationId}'.`, databaseError)
    }
  }
}
