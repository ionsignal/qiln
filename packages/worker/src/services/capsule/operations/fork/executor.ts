import {
  CapsuleOperationType,
  CapsuleSshAccessCommandName,
  SshBranchAccessBlockReason,
  TargetType,
  type CapsuleChannel,
} from '@qiln/core/server'
import { IncusError } from '../../../../errors'
import { CapsuleOperationStepRunner } from '../shared'
import { ForkExecutionState } from './state'
import { ForkStep } from './steps'
import type { CapsuleOperationStepStore } from '../shared'
import type {
  CapsuleBranchEventPublisher,
  CapsuleLifecycleEventPublisher,
  CapsuleOperationEventPublisher,
} from '../../events'
import type { ForkCompensation } from './compensation'
import type { ForkProvider } from './provider'
import type { ForkRepository } from './persistence'
import type { ForkExecution, ForkTerminal } from './types'

export interface ForkExecutorDependencies {
  repository: ForkRepository
  steps: CapsuleOperationStepStore
  provider: ForkProvider
  compensation: ForkCompensation
  channel: CapsuleChannel
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
  branchEvents: CapsuleBranchEventPublisher
}

/**
 * Executes one accepted fork from immutable PostgreSQL input.
 *
 * The executor receives only an operation ID and never resumes provider work
 * after process loss. Host SSH access is initialized as blocked before provider
 * materialization; enablement remains owned by branch start.
 */
export class ForkExecutor {
  private readonly runner: CapsuleOperationStepRunner

  constructor(private readonly dependencies: ForkExecutorDependencies) {
    this.runner = new CapsuleOperationStepRunner(dependencies.steps)
  }

  public async execute(operationId: string): Promise<void> {
    const state = new ForkExecutionState()
    let execution: ForkExecution | null = null
    let claimed = false
    try {
      state.phase('claim')
      const running = await this.dependencies.repository.claim(operationId)
      claimed = true
      const fork = running.execution
      execution = fork
      this.dependencies.operationEvents.publishChanged(running.operation)
      await this.step(fork, state, ForkStep.PLAN, {
        sourceSnapshotId: fork.sourceSnapshotId,
        resourceCount: fork.plan.resources.length,
        volumeCount: fork.plan.volumes.length,
        fileCount: fork.plan.files.length,
      })
      await this.step(
        fork,
        state,
        ForkStep.INITIALIZE_SSH,
        {
          reason: SshBranchAccessBlockReason.BRANCH_FORKED,
        },
        async () => {
          const result = await this.dependencies.channel.command(CapsuleSshAccessCommandName.BRANCH_ACCESS_INITIALIZE, {
            target: {
              type: TargetType.OWNER,
              id: fork.ownerId,
            },
            capsuleId: fork.capsuleId,
            branchId: fork.branchId,
            reason: SshBranchAccessBlockReason.BRANCH_FORKED,
          })
          if (
            result.access.capsuleId !== fork.capsuleId ||
            result.access.branchId !== fork.branchId ||
            result.access.state !== 'blocked'
          ) {
            throw new IncusError('Host SSH policy did not confirm blocked access for the fork branch.', 'CONFLICT', {
              operationId,
              branchId: fork.branchId,
            })
          }
        },
      )
      await this.step(
        fork,
        state,
        ForkStep.ROOTFS,
        {
          provider: fork.plan.instance.rootfsImagePin.provider,
          project: fork.plan.instance.rootfsImagePin.project,
          fingerprint: fork.plan.instance.rootfsImagePin.fingerprint,
        },
        () => this.dependencies.provider.rootfs(fork),
      )
      state.phase('intent')
      await this.dependencies.repository.intent(operationId)
      state.providerIntent()
      await this.step(
        fork,
        state,
        ForkStep.PROJECT,
        {
          namespace: fork.plan.project.namespace,
        },
        () => this.dependencies.provider.project(fork),
      )
      await this.step(
        fork,
        state,
        ForkStep.BINDS,
        {
          count: fork.plan.binds.length,
        },
        () => this.dependencies.provider.binds(fork),
      )
      await this.step(
        fork,
        state,
        ForkStep.VOLUMES,
        {
          count: fork.plan.volumes.length,
        },
        () => this.dependencies.provider.volumes(fork),
      )
      await this.step(
        fork,
        state,
        ForkStep.INSTANCE,
        {
          instanceName: fork.plan.instance.instanceName,
        },
        () => this.dependencies.provider.instance(fork),
      )
      await this.step(
        fork,
        state,
        ForkStep.FILES,
        {
          count: fork.plan.files.length,
        },
        () => this.dependencies.provider.files(fork),
      )
      await this.step(
        fork,
        state,
        ForkStep.VERIFY,
        {
          expectedProviderStatus: 'Stopped',
        },
        () => this.dependencies.provider.verify(fork),
      )
      // Entering finalization disables destructive compensation even if
      // completion-step accounting fails before the commit action runs.
      state.beginFinalization()
      await this.step(
        fork,
        state,
        ForkStep.COMPLETE,
        {
          branchStatus: 'offline',
        },
        async () => {
          state.phase('complete')
          const committed = await this.dependencies.repository.commit(operationId)
          state.completed()
          this.publish(committed)
        },
      )
    } catch (error: unknown) {
      if (state.hasCompleted) {
        console.error(`[ForkExecutor] Fork '${operationId}' committed, but post-commit accounting failed.`, error)
        return
      }
      if (!claimed) {
        // A failed or ambiguously acknowledged claim cannot prove this
        // invocation owns execution. Startup abandonment handles work left over.
        throw error
      }
      await this.fail(operationId, execution, state, error)
      throw error
    }
  }

  private async fail(
    operationId: string,
    execution: ForkExecution | null,
    state: ForkExecutionState,
    error: unknown,
  ): Promise<void> {
    const failedPhase = state.currentPhase
    const failedStep = state.currentStep
    const finalizationStarted = state.hasFinalizationStarted
    const context: Record<string, unknown> = {
      operationId,
      capsuleId: execution?.capsuleId,
      branchId: execution?.branchId,
      sourceSnapshotId: execution?.sourceSnapshotId,
      phase: 'fork_execution_failure',
      failedPhase,
      failedStep,
      providerIntentObserved: state.hasProviderIntent,
      providerOwnershipUncertain: failedStep === ForkStep.PROJECT,
      finalizationAttempted: finalizationStarted,
    }
    state.phase('classify')
    if (finalizationStarted || !state.hasProviderIntent || !execution) {
      const terminal = await this.dependencies.repository.classify(operationId, error, context)
      if (terminal) {
        this.publish(terminal)
      }
      return
    }
    try {
      const compensation = await this.dependencies.compensation.run(operationId)
      context.compensationAttempted = true
      context.compensationComplete = compensation.complete
      if (compensation.complete && context.providerOwnershipUncertain !== true) {
        const terminal = await this.dependencies.repository.compensated(operationId, error, context)
        this.publish(terminal)
        return
      }
      context.compensationFailures = compensation.failures
    } catch (compensationError: unknown) {
      console.error(`[ForkExecutor] Fork '${operationId}' compensation or terminalization could not be proven.`, {
        forkError: error,
        compensationError,
      })
      context.compensationAttempted = true
      context.compensationUncertain = true
      context.compensationError =
        compensationError instanceof Error
          ? {
              name: compensationError.name,
              message: compensationError.message,
            }
          : {
              value: compensationError,
            }
    }
    // Fresh classification preserves a terminal result if its transaction
    // committed despite a lost acknowledgement. It never retries compensation.
    const terminal = await this.dependencies.repository.classify(operationId, error, context)
    if (terminal) {
      this.publish(terminal)
    }
  }

  private async step(
    execution: ForkExecution,
    state: ForkExecutionState,
    step: ForkStep,
    metadata: Record<string, unknown>,
    action: () => Promise<void> = async () => {},
  ): Promise<void> {
    state.step(step)
    await this.runner.run(
      {
        operationId: execution.operationId,
        capsuleId: execution.capsuleId,
        ownerId: execution.ownerId,
        branchId: execution.branchId,
        branchName: execution.branchName,
        stepKey: step,
        metadata,
        failureContext: {
          operationType: CapsuleOperationType.FORK,
          action: 'execute_fork_step',
        },
      },
      action,
    )
  }

  private publish(result: ForkTerminal): void {
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
