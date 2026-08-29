import {
  CapsuleOperationType,
  CapsuleSshAccessCommandName,
  SshBranchAccessBlockReason,
  TargetType,
  type CapsuleChannel,
} from '@qiln/core/server'
import { CapsuleOperationStepRunner } from '../shared'
import { CreateCapsuleFailurePhase, createCreateCapsuleFailureContext } from './failureContext'
import { CreateCapsuleExecutionState } from './executionState'
import { CreateCapsuleCompensation } from './compensation'
import { CreateCapsuleResourcePlanner, createResourceInventoryEntries } from './planner'
import {
  createManagedVolumes,
  createRootBranchInstance,
  ensureOwnerNamespace,
  recordExternalBindMounts,
  writeProvisioningFiles,
  type CreateCapsuleResourceProvisioningDependencies,
} from './resourceProvisioning'
import { CreateCapsuleStepKey } from './stepKeys'
import { createCapsuleBranchResourceInventoryDigest } from '../../resource/inventory'
import type { CapsuleOperationStepStore } from '../shared'
import type { CreateCapsuleCompensationFailure } from './failureContext'
import type { CreateCapsuleOperationRepository } from './repository'
import type { CapsuleBranchResourceStore } from '../../resource/store'
import type { CapsuleResourceDriver } from '../../resource/driver'
import type { CapsuleBranchEventPublisher } from '../../events/branch'
import type { CapsuleLifecycleEventPublisher, CapsuleOperationEventPublisher } from '../../events'
import type { ProjectService } from '../../../project'
import type { CreateCapsuleOperationContext, CreateCapsuleResourcePlan, CreateCapsuleTerminalResult } from './types'

export interface CreateCapsuleExecutorDependencies {
  repository: CreateCapsuleOperationRepository
  steps: CapsuleOperationStepStore
  resources: CapsuleBranchResourceStore
  driver: CapsuleResourceDriver
  project: ProjectService
  channel: CapsuleChannel
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
  branchEvents: CapsuleBranchEventPublisher
}

/**
 * Executes one accepted capsule create operation from durable PostgreSQL input.
 *
 * The executor receives only the operation ID. It reloads the complete
 * immutable execution input from PostgreSQL before claiming the operation.
 *
 * The workflow remains explicit here. Plain resource-provisioning functions own
 * focused per-resource mechanics but cannot reorder, skip, resume, retry, or
 * independently terminalize the create operation.
 */
export class CreateCapsuleExecutor {
  private readonly planner = new CreateCapsuleResourcePlanner()
  private readonly compensation: CreateCapsuleCompensation
  private readonly stepRunner: CapsuleOperationStepRunner
  private readonly resourceProvisioning: CreateCapsuleResourceProvisioningDependencies

  constructor(private readonly dependencies: CreateCapsuleExecutorDependencies) {
    this.resourceProvisioning = {
      resources: dependencies.resources,
      driver: dependencies.driver,
    }
    this.compensation = new CreateCapsuleCompensation({
      resources: dependencies.resources,
      driver: dependencies.driver,
    })
    this.stepRunner = new CapsuleOperationStepRunner(dependencies.steps)
  }

  public async execute(operationId: string): Promise<void> {
    const state = new CreateCapsuleExecutionState(CreateCapsuleFailurePhase.LOAD_EXECUTION_INPUT)
    let context: CreateCapsuleOperationContext | null = null

    try {
      state.beginTerminalPhase(CreateCapsuleFailurePhase.LOAD_EXECUTION_INPUT)
      const input = await this.dependencies.repository.loadAcceptedExecutionInput(operationId)
      const executionContext: CreateCapsuleOperationContext = {
        operationId: input.operationId,
        capsuleId: input.capsuleId,
        ownerId: input.ownerId,
        rootBranchId: input.rootBranchId,
        rootBranchName: input.rootBranchName,
        namespace: this.dependencies.project.getNamespace(input.ownerId),
      }
      context = executionContext

      state.beginTerminalPhase(CreateCapsuleFailurePhase.CLAIM_OPERATION)

      const runningOperation = await this.dependencies.repository.claimForExecution(operationId)
      this.dependencies.operationEvents.publishChanged(runningOperation)
      await this.runStep(
        executionContext,
        state,
        CreateCapsuleStepKey.INITIALIZE_SSH_ACCESS_FENCE,
        {
          reason: SshBranchAccessBlockReason.BRANCH_CREATED,
        },
        async () => {
          await this.dependencies.channel.command(CapsuleSshAccessCommandName.BRANCH_ACCESS_INITIALIZE, {
            target: {
              type: TargetType.OWNER,
              id: executionContext.ownerId,
            },
            capsuleId: executionContext.capsuleId,
            branchId: executionContext.rootBranchId,
            reason: SshBranchAccessBlockReason.BRANCH_CREATED,
          })
        },
      )
      const resourcePlan = await this.runStep(
        executionContext,
        state,
        CreateCapsuleStepKey.PLAN_RESOURCES,
        {
          blueprintName: input.blueprintName,
          blueprintDigest: input.blueprintDigest,
          volumeDefinitionCount: input.blueprintSnapshot.provisioning.volumes.length,
          provisioningFileDefinitionCount: input.blueprintSnapshot.provisioning.files.length,
        },
        () =>
          this.planner.createPlan({
            namespace: executionContext.namespace,
            rootBranchId: executionContext.rootBranchId,
            rootBranchName: executionContext.rootBranchName,
            cpu: input.cpu,
            memory: input.memory,
            blueprint: input.blueprintSnapshot,
            rootfsImagePin: input.rootfsImagePin,
          }),
      )

      await this.runStep(
        executionContext,
        state,
        CreateCapsuleStepKey.RECORD_RESOURCE_INVENTORY,
        {
          resourceCount: this.resourceCount(resourcePlan),
        },
        () => this.recordResourceInventoryProof(executionContext, resourcePlan),
      )

      await this.runStep(
        executionContext,
        state,
        CreateCapsuleStepKey.VERIFY_ROOTFS_IMAGE,
        {
          provider: input.rootfsImagePin.provider,
          project: input.rootfsImagePin.project,
          fingerprint: input.rootfsImagePin.fingerprint,
        },
        async () => {
          await this.dependencies.driver.verifyRootfs(input.rootfsImagePin)
        },
      )

      state.beginTerminalPhase(CreateCapsuleFailurePhase.COMMIT_PROVIDER_INTENT_FENCE)

      // The operation-wide fence must commit before ensureOwnerNamespace or any
      // other Incus state-changing call.
      await this.dependencies.repository.commitProviderIntentFence(executionContext.operationId)
      state.markProviderIntentCommitted()

      await this.runStep(
        executionContext,
        state,
        CreateCapsuleStepKey.ENSURE_NAMESPACE,
        {
          namespace: executionContext.namespace,
          resourceKey: resourcePlan.project.resourceKey,
        },
        () => ensureOwnerNamespace(this.resourceProvisioning, executionContext, resourcePlan.project, state),
      )

      await this.runStep(
        executionContext,
        state,
        CreateCapsuleStepKey.RECORD_BIND_MOUNTS,
        {
          count: resourcePlan.bindMounts.length,
        },
        () => recordExternalBindMounts(this.resourceProvisioning, executionContext, resourcePlan.bindMounts),
      )

      await this.runStep(
        executionContext,
        state,
        CreateCapsuleStepKey.CREATE_VOLUMES,
        {
          count: resourcePlan.volumes.length,
        },
        () => createManagedVolumes(this.resourceProvisioning, executionContext, resourcePlan.volumes, state),
      )

      await this.runStep(
        executionContext,
        state,
        CreateCapsuleStepKey.CREATE_INSTANCE,
        {
          instanceName: resourcePlan.instance.instanceName,
          imageProject: resourcePlan.instance.rootfsImagePin.project,
          imageFingerprint: resourcePlan.instance.rootfsImagePin.fingerprint,
          resourceKey: resourcePlan.instance.resourceKey,
        },
        () => createRootBranchInstance(this.resourceProvisioning, executionContext, resourcePlan.instance, state),
      )

      await this.runStep(
        executionContext,
        state,
        CreateCapsuleStepKey.WRITE_PROVISIONING_FILES,
        {
          count: resourcePlan.files.length,
        },
        () =>
          writeProvisioningFiles(
            this.resourceProvisioning,
            executionContext,
            resourcePlan.instance.instanceName,
            resourcePlan.files,
            state,
          ),
      )

      await this.runStep(
        executionContext,
        state,
        CreateCapsuleStepKey.COMPLETE_CREATE,
        {
          capsuleStatus: 'active',
          rootBranchStatus: 'offline',
        },
        async () => {
          const completed = await this.dependencies.repository.completeCreate(executionContext.operationId)
          state.markCompletionCommitted()
          this.publishTerminalResult(completed)
        },
      )
    } catch (error: unknown) {
      if (state.completionCommitted) {
        // Aggregate completion already committed. Step-accounting or
        // post-commit invalidation failure cannot reverse the completed create.
        console.error(
          `[CreateCapsuleExecutor] Capsule create '${operationId}' completed, but post-commit accounting failed.`,
          error,
        )
        return
      }
      await this.resolveFailure(operationId, context, state, error)
      throw error
    }
  }

  private async recordResourceInventoryProof(
    context: CreateCapsuleOperationContext,
    plan: CreateCapsuleResourcePlan,
  ): Promise<void> {
    const digest = createCapsuleBranchResourceInventoryDigest(
      createResourceInventoryEntries(plan),
      'capsule create planned resource inventory',
    )
    await this.dependencies.repository.recordResourceInventoryProof(
      context.ownerId,
      context.operationId,
      context.rootBranchId,
      digest,
    )
  }

  private async resolveFailure(
    operationId: string,
    context: CreateCapsuleOperationContext | null,
    state: CreateCapsuleExecutionState,
    error: unknown,
  ): Promise<void> {
    const failedPhase = state.currentFailurePhase
    const failedStepKey = state.currentStepKey
    if (!state.providerIntentCommitted) {
      await this.failBeforeProviderMutation(operationId, context, state, error, failedPhase, failedStepKey)
      return
    }
    if (!context) {
      await this.markCleanupRequired(
        operationId,
        null,
        state,
        error,
        false,
        [],
        'missing_execution_context_after_provider_intent',
        failedPhase,
        failedStepKey,
      )
      return
    }
    if (failedPhase === CreateCapsuleFailurePhase.COMPLETE_CREATE) {
      await this.markCleanupRequired(
        operationId,
        context,
        state,
        error,
        false,
        [],
        'complete_create_transaction_failed',
        failedPhase,
        failedStepKey,
      )
      return
    }
    const compensation = await this.compensation.compensateCreatedResources(
      {
        operationId: context.operationId,
        namespace: context.namespace,
        rootBranchName: context.rootBranchName,
      },
      state.compensation,
    )
    if (state.providerOwnershipUncertain || !compensation.fullyCompensated) {
      await this.markCleanupRequired(
        operationId,
        context,
        state,
        error,
        true,
        compensation.failures,
        state.providerOwnershipUncertain ? 'provider_ownership_uncertain' : 'compensation_incomplete',
        failedPhase,
        failedStepKey,
      )
      return
    }
    await this.failAfterSuccessfulCompensation(context, state, error, failedPhase, failedStepKey)
  }

  private async failBeforeProviderMutation(
    operationId: string,
    context: CreateCapsuleOperationContext | null,
    state: CreateCapsuleExecutionState,
    error: unknown,
    failedPhase: CreateCapsuleFailurePhase,
    failedStepKey: CreateCapsuleStepKey | null,
  ): Promise<void> {
    state.beginTerminalPhase(CreateCapsuleFailurePhase.FAIL_BEFORE_PROVIDER_MUTATION)
    const terminal = await this.dependencies.repository.failBeforeProviderMutation(
      operationId,
      error,
      createCreateCapsuleFailureContext({
        operationId,
        capsuleId: context?.capsuleId,
        rootBranchId: context?.rootBranchId,
        rootBranchName: context?.rootBranchName,
        phase: CreateCapsuleFailurePhase.FAIL_BEFORE_PROVIDER_MUTATION,
        failedPhase,
        stepKey: failedStepKey,
        action: 'classify_create_failure_before_provider_mutation',
        providerIntentCommitted: false,
        providerOwnershipUncertain: state.providerOwnershipUncertain,
        completionCommitted: false,
        compensationAttempted: false,
        compensationCompleted: false,
      }),
    )
    this.publishTerminalResult(terminal)
  }

  private async failAfterSuccessfulCompensation(
    context: CreateCapsuleOperationContext,
    state: CreateCapsuleExecutionState,
    error: unknown,
    failedPhase: CreateCapsuleFailurePhase,
    failedStepKey: CreateCapsuleStepKey | null,
  ): Promise<void> {
    state.beginTerminalPhase(CreateCapsuleFailurePhase.FAIL_AFTER_SUCCESSFUL_COMPENSATION)
    const failureContext = createCreateCapsuleFailureContext({
      operationId: context.operationId,
      capsuleId: context.capsuleId,
      rootBranchId: context.rootBranchId,
      rootBranchName: context.rootBranchName,
      phase: CreateCapsuleFailurePhase.FAIL_AFTER_SUCCESSFUL_COMPENSATION,
      failedPhase,
      stepKey: failedStepKey,
      action: 'fail_create_after_successful_compensation',
      providerIntentCommitted: true,
      providerOwnershipUncertain: false,
      completionCommitted: false,
      compensationAttempted: true,
      compensationCompleted: true,
    })
    try {
      const failed = await this.dependencies.repository.failAfterSuccessfulCompensation(
        context.operationId,
        error,
        failureContext,
      )
      this.publishTerminalResult(failed)
    } catch (terminalizationError: unknown) {
      console.error(
        `[CreateCapsuleExecutor] Failed to persist compensated create failure for '${context.operationId}'.`,
        {
          createError: error,
          terminalizationError,
        },
      )
      await this.markCleanupRequired(
        context.operationId,
        context,
        state,
        terminalizationError,
        true,
        [],
        'fail_after_successful_compensation_transaction_failed',
        failedPhase,
        failedStepKey,
      )
    }
  }

  private async markCleanupRequired(
    operationId: string,
    context: CreateCapsuleOperationContext | null,
    state: CreateCapsuleExecutionState,
    error: unknown,
    compensationAttempted: boolean,
    compensationFailures: readonly CreateCapsuleCompensationFailure[],
    action: string,
    failedPhase: CreateCapsuleFailurePhase,
    failedStepKey: CreateCapsuleStepKey | null,
  ): Promise<void> {
    state.beginTerminalPhase(CreateCapsuleFailurePhase.MARK_CLEANUP_REQUIRED)
    const failureContext = createCreateCapsuleFailureContext({
      operationId,
      capsuleId: context?.capsuleId,
      rootBranchId: context?.rootBranchId,
      rootBranchName: context?.rootBranchName,
      phase: CreateCapsuleFailurePhase.MARK_CLEANUP_REQUIRED,
      failedPhase,
      stepKey: failedStepKey,
      action,
      providerIntentCommitted: state.providerIntentCommitted,
      providerOwnershipUncertain: state.providerOwnershipUncertain,
      completionCommitted: false,
      compensationAttempted,
      compensationCompleted: compensationAttempted && compensationFailures.length === 0,
      compensationFailures,
    })
    try {
      const cleanup = await this.dependencies.repository.markCleanupRequired(operationId, error, failureContext)
      this.publishTerminalResult(cleanup)
    } catch (cleanupError: unknown) {
      console.error(`[CreateCapsuleExecutor] Failed to persist cleanup-required state for '${operationId}'.`, {
        createError: error,
        cleanupError,
      })
      throw cleanupError
    }
  }

  private async runStep<TResult>(
    context: CreateCapsuleOperationContext,
    state: CreateCapsuleExecutionState,
    stepKey: CreateCapsuleStepKey,
    metadata: Record<string, unknown>,
    action: () => Promise<TResult> | TResult,
  ): Promise<TResult> {
    state.beginStep(stepKey)
    return await this.stepRunner.run(
      {
        operationId: context.operationId,
        capsuleId: context.capsuleId,
        ownerId: context.ownerId,
        branchId: context.rootBranchId,
        branchName: context.rootBranchName,
        stepKey,
        metadata,
        failureContext: {
          operationType: CapsuleOperationType.CREATE,
          action: 'execute_create_step',
        },
      },
      action,
    )
  }

  private publishTerminalResult(result: CreateCapsuleTerminalResult): void {
    this.dependencies.operationEvents.publishChanged(result.operation)
    this.dependencies.lifecycleEvents.publishChanged(result.operation.ownerId, result.capsule)
    if (result.branch) {
      this.dependencies.branchEvents.publishStateChanged(
        result.operation.ownerId,
        result.branch.capsuleId,
        result.branch.name,
        result.branch.status,
      )
    }
  }

  private resourceCount(plan: CreateCapsuleResourcePlan): number {
    return 1 + plan.bindMounts.length + plan.volumes.length + 1 + plan.files.length
  }
}
