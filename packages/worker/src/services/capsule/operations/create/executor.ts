import {
  CapsuleOperationType,
  CapsuleSshAccessCommandName,
  SshBranchAccessBlockReason,
  TargetType,
  type CapsuleChannel,
  type CapsuleTables,
} from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { CapsuleOperationStepRunner } from '../shared'
import { CapsuleCreatePhase } from './execution/phases'
import { CapsuleCreateCompensationScope, type CapsuleCreateExecutionState } from './execution/state'
import { CapsuleCreateStepKey } from './execution/steps'
import { createResourceInventoryEntries } from './resource/plan'
import type { CapsuleOperationStepStore } from '../shared'
import type { CapsuleCreateRepository } from './persistence/repository'
import type { CapsuleCreateCompensation } from './resource/compensate'
import type { CapsuleCreateResourcePlanner } from './resource/plan'
import type { CapsuleCreateProvisioner } from './resource/provision'
import type { CapsuleBranchEventPublisher } from '../../events/branch'
import type { CapsuleLifecycleEventPublisher, CapsuleOperationEventPublisher } from '../../events'
import type { ProjectService } from '../../../project'
import type {
  CapsuleCreateCompensationResult,
  CapsuleCreateOperationContext,
  CapsuleCreateTerminalResult,
} from './types'

export interface CapsuleCreateExecutorDependencies<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  repository: CapsuleCreateRepository<TDatabase, TTables>
  steps: CapsuleOperationStepStore<TDatabase, TTables>
  planner: CapsuleCreateResourcePlanner
  provisioner: CapsuleCreateProvisioner<TDatabase, TTables>
  compensator: CapsuleCreateCompensation<TDatabase, TTables>
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
export class CapsuleCreateExecutor<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  private readonly stepRunner: CapsuleOperationStepRunner<TDatabase, TTables>

  constructor(private readonly dependencies: CapsuleCreateExecutorDependencies<TDatabase, TTables>) {
    this.stepRunner = new CapsuleOperationStepRunner<TDatabase, TTables>(dependencies.steps)
  }

  public async execute(operationId: string): Promise<void> {
    const state: CapsuleCreateExecutionState = {
      compensation: new CapsuleCreateCompensationScope(),
      phase: CapsuleCreatePhase.LOAD_EXECUTION_INPUT,
      providerIntentConfirmed: false,
      providerOwnershipUncertain: false,
      completionAttempted: false,
      completionConfirmed: false,
    }
    let context: CapsuleCreateOperationContext | null = null

    try {
      const input = await this.dependencies.repository.loadExecution(operationId)
      const executionContext: CapsuleCreateOperationContext = {
        operationId: input.operationId,
        capsuleId: input.capsuleId,
        ownerId: input.ownerId,
        rootBranchId: input.rootBranchId,
        rootBranchName: input.rootBranchName,
        namespace: this.dependencies.project.getNamespace(input.ownerId),
      }
      context = executionContext

      const runStep = <TResult>(
        stepKey: CapsuleCreateStepKey,
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

      state.phase = CapsuleCreatePhase.CLAIM_OPERATION

      const runningOperation = await this.dependencies.repository.claim(operationId)
      this.dependencies.operationEvents.publishChanged(runningOperation)
      await runStep(
        CapsuleCreateStepKey.INITIALIZE_SSH_ACCESS_FENCE,
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
        CapsuleCreateStepKey.PLAN_RESOURCES,
        {
          blueprintName: input.blueprintPin.name,
          blueprintDigest: input.blueprintPin.digest,
          volumeDefinitionCount: input.blueprintPin.blueprint.provisioning.volumes.length,
          provisioningFileDefinitionCount: input.blueprintPin.blueprint.provisioning.files.length,
        },
        () =>
          this.dependencies.planner.plan({
            namespace: executionContext.namespace,
            rootBranchId: executionContext.rootBranchId,
            rootBranchName: executionContext.rootBranchName,
            cpu: input.cpu,
            memory: input.memory,
            blueprintPin: input.blueprintPin,
            rootfsImagePin: input.rootfsImagePin,
          }),
      )

      const inventory = createResourceInventoryEntries(plan)
      await runStep(
        CapsuleCreateStepKey.MATERIALIZE_RESOURCES,
        {
          resourceCount: inventory.length,
        },
        () => this.dependencies.repository.materialize(operationId),
      )

      await runStep(
        CapsuleCreateStepKey.VERIFY_ROOTFS_IMAGE,
        {
          provider: input.rootfsImagePin.provider,
          project: input.rootfsImagePin.project,
          fingerprint: input.rootfsImagePin.fingerprint,
        },
        () => this.dependencies.provisioner.verifyRootfs(input.rootfsImagePin),
      )

      state.phase = CapsuleCreatePhase.COMMIT_PROVIDER_INTENT_FENCE

      // The operation-wide fence must commit before ensureNamespace or any
      // other Incus state-changing call.
      await this.dependencies.repository.commitProviderIntent(operationId)
      state.providerIntentConfirmed = true

      await runStep(
        CapsuleCreateStepKey.ENSURE_NAMESPACE,
        {
          namespace: executionContext.namespace,
          resourceKey: plan.project.resourceKey,
        },
        () => this.dependencies.provisioner.ensureNamespace(executionContext, plan.project, state),
      )

      await runStep(
        CapsuleCreateStepKey.RECORD_BIND_MOUNTS,
        {
          count: plan.bindMounts.length,
        },
        () => this.dependencies.provisioner.recordBindMounts(executionContext, plan.bindMounts),
      )

      await runStep(
        CapsuleCreateStepKey.CREATE_VOLUMES,
        {
          count: plan.volumes.length,
        },
        () => this.dependencies.provisioner.createVolumes(executionContext, plan.volumes, state),
      )

      await runStep(
        CapsuleCreateStepKey.CREATE_INSTANCE,
        {
          instanceName: plan.instance.instanceName,
          imageProject: plan.instance.rootfsImagePin.project,
          imageFingerprint: plan.instance.rootfsImagePin.fingerprint,
          resourceKey: plan.instance.resourceKey,
        },
        () => this.dependencies.provisioner.createInstance(executionContext, plan.instance, state),
      )

      await runStep(
        CapsuleCreateStepKey.WRITE_PROVISIONING_FILES,
        {
          count: plan.files.length,
        },
        () => this.dependencies.provisioner.writeFiles(executionContext, plan.instance.instanceName, plan.files, state),
      )

      // Entering completion disables destructive compensation, including when
      // completion-step accounting fails before its transaction can run.
      state.completionAttempted = true
      await runStep(
        CapsuleCreateStepKey.COMPLETE_CREATE,
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
          `[CapsuleCreateExecutor] Capsule create '${operationId}' completed, but post-commit accounting failed.`,
          error,
        )
        return
      }
      let compensation: CapsuleCreateCompensationResult | null = null
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

  private publishTerminalResult(result: CapsuleCreateTerminalResult): void {
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
