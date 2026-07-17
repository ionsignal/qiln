import { CapsuleOperationType } from '@qiln/core/server'
import { CapsuleOperationStepRunner } from '../shared'
import { DestroyCapsuleExecutionState } from './executionState'
import { DestroyCapsuleFailurePhase, createDestroyCapsuleFailureContext } from './failureContext'
import { DestroyCapsulePlanner } from './planner'
import { DestroyCapsuleStepKey } from './stepKeys'
import type { CapsuleOperationStepStore } from '../shared'
import type { CapsuleBranchEventPublisher } from '../../events/branch'
import type { CapsuleLifecycleEventPublisher, CapsuleOperationEventPublisher } from '../../events'
import type { CapsuleBranchResourceStore } from '../../stores'
import type { DestroyCapsuleOperationRepository } from './repository'
import type { DestroyCapsuleProvider } from './provider'
import type { DestroyCapsuleOperationContext, DestroyCapsulePlan, DestroyCapsuleTerminalResult } from './types'

export interface DestroyCapsuleExecutorDependencies {
  repository: DestroyCapsuleOperationRepository
  steps: CapsuleOperationStepStore
  resources: CapsuleBranchResourceStore
  provider: DestroyCapsuleProvider
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
  branchEvents: CapsuleBranchEventPublisher
}

/**
 * Executes one accepted destroy operation from durable PostgreSQL input.
 *
 * The executor receives only an operation ID and never retains command payload,
 * request context, or mutable caller state.
 */
export class DestroyCapsuleExecutor {
  private readonly planner = new DestroyCapsulePlanner()
  private readonly stepRunner: CapsuleOperationStepRunner

  constructor(private readonly dependencies: DestroyCapsuleExecutorDependencies) {
    this.stepRunner = new CapsuleOperationStepRunner(dependencies.steps)
  }

  public async execute(operationId: string): Promise<void> {
    const state = new DestroyCapsuleExecutionState(DestroyCapsuleFailurePhase.LOAD_EXECUTION_INPUT)
    let context: DestroyCapsuleOperationContext | null = null
    let plan: DestroyCapsulePlan | null = null
    try {
      state.beginTerminalPhase(DestroyCapsuleFailurePhase.LOAD_EXECUTION_INPUT)

      const input = await this.dependencies.repository.loadAcceptedExecutionInput(operationId)
      const executionContext: DestroyCapsuleOperationContext = {
        operationId: input.operationId,
        ownerId: input.ownerId,
        capsuleId: input.capsuleId,
        branches: input.branches,
      }

      context = executionContext

      state.beginTerminalPhase(DestroyCapsuleFailurePhase.CLAIM_OPERATION)

      const running = await this.dependencies.repository.claimAccepted(operationId)
      this.dependencies.operationEvents.publishChanged(running)

      const plannedResources = await this.runStep(
        executionContext,
        state,
        DestroyCapsuleStepKey.PLAN_DESTROY,
        {
          branchCount: executionContext.branches.length,
        },
        async () => {
          const rows = await this.dependencies.resources.listBranchResourceInventories(executionContext.branches.map(branch => branch.id))

          return this.planner.createPlan(executionContext.ownerId, executionContext.capsuleId, executionContext.branches, rows)
        },
      )

      plan = plannedResources
      const summary = this.planner.summarize(plannedResources)

      state.beginTerminalPhase(DestroyCapsuleFailurePhase.COMMIT_PROVIDER_INTENT_FENCE)

      await this.dependencies.repository.commitProviderIntentFence(executionContext.operationId)
      state.markProviderIntentCommitted()

      await this.runStep(
        executionContext,
        state,
        DestroyCapsuleStepKey.DELETE_BRANCH_INSTANCES,
        {
          count: summary.instanceCount,
        },
        () => this.dependencies.provider.deleteInstances(executionContext, plannedResources.instances),
      )

      await this.runStep(
        executionContext,
        state,
        DestroyCapsuleStepKey.DELETE_BRANCH_VOLUMES,
        {
          count: summary.volumeCount,
        },
        () => this.dependencies.provider.deleteVolumes(executionContext, plannedResources.volumes),
      )

      await this.runStep(
        executionContext,
        state,
        DestroyCapsuleStepKey.FINALIZE_DERIVED_RESOURCE_OUTCOMES,
        {
          count: summary.provisioningFileCount,
        },
        () => this.dependencies.provider.finalizeDerivedResources(executionContext, plannedResources),
      )

      await this.runStep(
        executionContext,
        state,
        DestroyCapsuleStepKey.VERIFY_TERMINAL_RESOURCE_OUTCOMES,
        {
          resourceCount: plannedResources.resourceIds.size,
        },
        async () => {
          const rows = await this.dependencies.resources.listBranchResourceInventories(
            plannedResources.branches.map(branchPlan => branchPlan.branch.id),
          )
          this.planner.verifyTerminalOutcomes(plannedResources, rows)
        },
      )

      state.beginTerminalPhase(DestroyCapsuleFailurePhase.COMPLETE_DESTROY)
      const completed = await this.dependencies.repository.complete(executionContext.operationId)
      state.markAggregateCompletionCommitted()
      this.publishTerminalResult(completed)
    } catch (executionError: unknown) {
      if (state.completionCommitted) {
        console.error(
          `[DestroyCapsuleExecutor] Capsule destroy '${operationId}' committed, but a later non-durable action failed. Preserving terminal state.`,
          executionError,
        )
        return
      }
      const failedPhase = state.currentFailurePhase
      const failedStepKey = state.currentStepKey
      const classified = await this.classifyFailure(operationId, context, state, plan, executionError, failedPhase, failedStepKey)
      if (!classified) {
        /**
         * A null classification result means PostgreSQL already contains a
         * terminal operation. This covers an ambiguous response after a
         * successful completion commit and prevents the executor from
         * overwriting or reinterpreting committed terminal state.
         */
        return
      }

      /**
       * The repository committed operation-specific terminal failure state.
       * Rethrowing preserves process-level diagnostics without creating retry
       * or resume behavior.
       */
      throw executionError
    }
  }

  private async classifyFailure(
    operationId: string,
    context: DestroyCapsuleOperationContext | null,
    state: DestroyCapsuleExecutionState,
    plan: DestroyCapsulePlan | null,
    error: unknown,
    failedPhase: DestroyCapsuleFailurePhase,
    failedStepKey: DestroyCapsuleStepKey | null,
  ): Promise<boolean> {
    const summary = plan === null ? null : this.planner.summarize(plan)

    state.beginTerminalPhase(DestroyCapsuleFailurePhase.CLASSIFY_EXECUTION_FAILURE)

    let terminal: DestroyCapsuleTerminalResult | null
    try {
      terminal = await this.dependencies.repository.classifyExecutionFailure(
        operationId,
        error,
        createDestroyCapsuleFailureContext({
          operationId,
          capsuleId: context?.capsuleId,
          phase: DestroyCapsuleFailurePhase.CLASSIFY_EXECUTION_FAILURE,
          failedPhase,
          stepKey: failedStepKey,
          action: 'classify_destroy_execution_failure',
          providerIntentCommitted: state.providerIntentCommitted,
          providerOwnershipUncertain: state.providerIntentCommitted,
          aggregateCompletionCommitted: state.completionCommitted,
          branchCount: context?.branches.length,
          instanceCount: summary?.instanceCount,
          volumeCount: summary?.volumeCount,
          provisioningFileCount: summary?.provisioningFileCount,
        }),
      )
    } catch (classificationError: unknown) {
      console.error(`[DestroyCapsuleExecutor] Failed to terminalize destroy operation '${operationId}'.`, {
        executionError: error,
        classificationError,
        failedPhase,
      })
      throw classificationError
    }
    if (terminal === null) {
      console.warn(`[DestroyCapsuleExecutor] Destroy operation '${operationId}' was already terminal during failure classification.`, {
        failedPhase,
      })
      return false
    }
    this.publishTerminalResult(terminal)
    return true
  }

  private async runStep<TResult>(
    context: DestroyCapsuleOperationContext,
    state: DestroyCapsuleExecutionState,
    stepKey: DestroyCapsuleStepKey,
    metadata: Record<string, unknown>,
    action: () => Promise<TResult> | TResult,
  ): Promise<TResult> {
    state.beginStep(stepKey)
    return await this.stepRunner.run(
      {
        operationId: context.operationId,
        capsuleId: context.capsuleId,
        ownerId: context.ownerId,
        branchId: null,
        branchName: null,
        stepKey,
        metadata,
        failureContext: {
          operationType: CapsuleOperationType.DESTROY,
          action: 'execute_destroy_step',
        },
      },
      action,
    )
  }

  private publishTerminalResult(result: DestroyCapsuleTerminalResult): void {
    this.dependencies.operationEvents.publishChanged(result.operation)
    this.dependencies.lifecycleEvents.publishChanged(result.operation.ownerId, result.capsule)
    for (const branch of result.branches) {
      this.dependencies.branchEvents.publishStateChanged(result.operation.ownerId, branch.capsuleId, branch.name, branch.status)
    }
  }
}
