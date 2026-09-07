import {
  CapsuleOperationType,
  CapsuleSshAccessCommandName,
  SshBranchAccessBlockReason,
  TargetType,
  type CapsuleChannel,
} from '@qiln/core/server'
import { CapsuleOperationStepRunner } from '../shared'
import { CreatePhase } from './execution/phases'
import { CreateCapsuleCompensationScope, type CreateCapsuleExecutionState } from './execution/state'
import { CreateCapsuleStepKey } from './execution/steps'
import { createResourceInventoryEntries } from './resource/plan'
import { createCapsuleBranchResourceInventoryDigest } from '../../resource/inventory'
import type { CapsuleOperationStepStore } from '../shared'
import type { CreateCapsuleOperationRepository } from './persistence/repository'
import type { CreateCapsuleCompensation } from './resource/compensate'
import type { CreateCapsuleResourcePlanner } from './resource/plan'
import type { CreateCapsuleProvisioner } from './resource/provision'
import type { CapsuleBranchEventPublisher } from '../../events/branch'
import type { CapsuleLifecycleEventPublisher, CapsuleOperationEventPublisher } from '../../events'
import type { ProjectService } from '../../../project'
import type {
  CreateCapsuleCompensationResult,
  CreateCapsuleOperationContext,
  CreateCapsuleTerminalResult,
} from './types'

export interface CreateCapsuleExecutorDependencies {
  repository: CreateCapsuleOperationRepository
  steps: CapsuleOperationStepStore
  planner: CreateCapsuleResourcePlanner
  provisioner: CreateCapsuleProvisioner
  compensator: CreateCapsuleCompensation
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
 * The workflow remains explicit here. The injected provisioner owns focused
 * per-resource mechanics but cannot reorder, skip, resume, retry, or
 * independently terminalize the create operation.
 */
export class CreateCapsuleExecutor {
  private readonly stepRunner: CapsuleOperationStepRunner

  constructor(private readonly dependencies: CreateCapsuleExecutorDependencies) {
    this.stepRunner = new CapsuleOperationStepRunner(dependencies.steps)
  }

  public async execute(operationId: string): Promise<void> {
    const state: CreateCapsuleExecutionState = {
      compensation: new CreateCapsuleCompensationScope(),
      phase: CreatePhase.LOAD_EXECUTION_INPUT,
      providerIntentConfirmed: false,
      providerOwnershipUncertain: false,
      completionAttempted: false,
      completionConfirmed: false,
    }
    let context: CreateCapsuleOperationContext | null = null

    try {
      const input = await this.dependencies.repository.loadExecution(operationId)
      const executionContext: CreateCapsuleOperationContext = {
        operationId: input.operationId,
        capsuleId: input.capsuleId,
        ownerId: input.ownerId,
        rootBranchId: input.rootBranchId,
        rootBranchName: input.rootBranchName,
        namespace: this.dependencies.project.getNamespace(input.ownerId),
      }
      context = executionContext

      const runStep = <TResult>(
        stepKey: CreateCapsuleStepKey,
        metadata: Record<string, unknown>,
        action: () => Promise<TResult> | TResult,
      ): Promise<TResult> => {
        state.phase = stepKey
        return this.stepRunner.run(
          {
            operationId: executionContext.operationId,
            capsuleId: executionContext.capsuleId,
            ownerId: executionContext.ownerId,
            branchId: executionContext.rootBranchId,
            branchName: executionContext.rootBranchName,
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

      state.phase = CreatePhase.CLAIM_OPERATION

      const runningOperation = await this.dependencies.repository.claim(operationId)
      this.dependencies.operationEvents.publishChanged(runningOperation)
      await runStep(
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
      const plan = await runStep(
        CreateCapsuleStepKey.PLAN_RESOURCES,
        {
          blueprintName: input.blueprintName,
          blueprintDigest: input.blueprintDigest,
          volumeDefinitionCount: input.blueprintSnapshot.provisioning.volumes.length,
          provisioningFileDefinitionCount: input.blueprintSnapshot.provisioning.files.length,
        },
        () =>
          this.dependencies.planner.plan({
            namespace: executionContext.namespace,
            rootBranchId: executionContext.rootBranchId,
            rootBranchName: executionContext.rootBranchName,
            cpu: input.cpu,
            memory: input.memory,
            blueprint: input.blueprintSnapshot,
            rootfsImagePin: input.rootfsImagePin,
          }),
      )

      const inventory = createResourceInventoryEntries(plan)
      await runStep(
        CreateCapsuleStepKey.RECORD_RESOURCE_INVENTORY,
        {
          resourceCount: inventory.length,
        },
        () =>
          this.dependencies.repository.recordInventory(
            operationId,
            createCapsuleBranchResourceInventoryDigest(inventory, 'capsule create planned resource inventory'),
          ),
      )

      await runStep(
        CreateCapsuleStepKey.VERIFY_ROOTFS_IMAGE,
        {
          provider: input.rootfsImagePin.provider,
          project: input.rootfsImagePin.project,
          fingerprint: input.rootfsImagePin.fingerprint,
        },
        () => this.dependencies.provisioner.verifyRootfs(input.rootfsImagePin),
      )

      state.phase = CreatePhase.COMMIT_PROVIDER_INTENT_FENCE

      // The operation-wide fence must commit before ensureNamespace or any
      // other Incus state-changing call.
      await this.dependencies.repository.commitProviderIntent(operationId)
      state.providerIntentConfirmed = true

      await runStep(
        CreateCapsuleStepKey.ENSURE_NAMESPACE,
        {
          namespace: executionContext.namespace,
          resourceKey: plan.project.resourceKey,
        },
        () => this.dependencies.provisioner.ensureNamespace(executionContext, plan.project, state),
      )

      await runStep(
        CreateCapsuleStepKey.RECORD_BIND_MOUNTS,
        {
          count: plan.bindMounts.length,
        },
        () => this.dependencies.provisioner.recordBindMounts(executionContext, plan.bindMounts),
      )

      await runStep(
        CreateCapsuleStepKey.CREATE_VOLUMES,
        {
          count: plan.volumes.length,
        },
        () => this.dependencies.provisioner.createVolumes(executionContext, plan.volumes, state),
      )

      await runStep(
        CreateCapsuleStepKey.CREATE_INSTANCE,
        {
          instanceName: plan.instance.instanceName,
          imageProject: plan.instance.rootfsImagePin.project,
          imageFingerprint: plan.instance.rootfsImagePin.fingerprint,
          resourceKey: plan.instance.resourceKey,
        },
        () => this.dependencies.provisioner.createInstance(executionContext, plan.instance, state),
      )

      await runStep(
        CreateCapsuleStepKey.WRITE_PROVISIONING_FILES,
        {
          count: plan.files.length,
        },
        () => this.dependencies.provisioner.writeFiles(executionContext, plan.instance.instanceName, plan.files, state),
      )

      // Entering completion disables destructive compensation, including when
      // completion-step accounting fails before its transaction can run.
      state.completionAttempted = true
      await runStep(
        CreateCapsuleStepKey.COMPLETE_CREATE,
        {
          capsuleStatus: 'active',
          rootBranchStatus: 'offline',
        },
        async () => {
          const completed = await this.dependencies.repository.complete(operationId)
          state.completionConfirmed = true
          this.publishTerminalResult(completed)
        },
      )
    } catch (error: unknown) {
      if (state.completionConfirmed) {
        // Aggregate completion already committed. Step-accounting or
        // post-commit invalidation failure cannot reverse the completed create.
        console.error(
          `[CreateCapsuleExecutor] Capsule create '${operationId}' completed, but post-commit accounting failed.`,
          error,
        )
        return
      }
      let compensation: CreateCapsuleCompensationResult | null = null
      if (state.providerIntentConfirmed && !state.completionAttempted && context !== null) {
        compensation = await this.dependencies.compensator.compensate(context, state.compensation)
      }
      const classified = await this.dependencies.repository.fail({
        operationId,
        error,
        phase: state.phase,
        providerIntentConfirmed: state.providerIntentConfirmed,
        providerOwnershipUncertain: state.providerOwnershipUncertain,
        completionAttempted: state.completionAttempted,
        compensation,
      })
      this.publishTerminalResult(classified)
      throw error
    }
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
}
