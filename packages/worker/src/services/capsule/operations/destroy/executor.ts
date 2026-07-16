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
    const input = await this.dependencies.repository.loadAcceptedExecutionInput(operationId)
    const running = await this.dependencies.repository.claimAccepted(operationId)

    this.dependencies.operationEvents.publishChanged(running)

    const context: DestroyCapsuleOperationContext = {
      operationId: input.operationId,
      ownerId: input.ownerId,
      capsuleId: input.capsuleId,
      branches: input.branches,
    }

    const state = new DestroyCapsuleExecutionState(DestroyCapsuleFailurePhase.PLAN_DESTROY)
    let plan: DestroyCapsulePlan | null = null

    try {
      const plannedResources = await this.runStep(
        context,
        state,
        DestroyCapsuleStepKey.PLAN_DESTROY,
        {
          branchCount: context.branches.length,
        },
        async () => {
          const rows = await this.dependencies.resources.listBranchResourceInventories(context.branches.map(branch => branch.id))

          return this.planner.createPlan(context.ownerId, context.capsuleId, context.branches, rows)
        },
      )

      plan = plannedResources
      const summary = this.planner.summarize(plannedResources)

      state.beginTerminalPhase(DestroyCapsuleFailurePhase.COMMIT_PROVIDER_INTENT_FENCE)

      // This operation-wide fence commits before an instance stop, instance
      // delete, volume delete, or any other provider mutation.
      await this.dependencies.repository.commitProviderIntentFence(context.operationId)
      state.markProviderIntentCommitted()

      await this.runStep(
        context,
        state,
        DestroyCapsuleStepKey.DELETE_BRANCH_INSTANCES,
        {
          count: summary.instanceCount,
        },
        () => this.dependencies.provider.deleteInstances(context, plannedResources.instances),
      )

      await this.runStep(
        context,
        state,
        DestroyCapsuleStepKey.DELETE_BRANCH_VOLUMES,
        {
          count: summary.volumeCount,
        },
        () => this.dependencies.provider.deleteVolumes(context, plannedResources.volumes),
      )

      await this.runStep(
        context,
        state,
        DestroyCapsuleStepKey.FINALIZE_DERIVED_RESOURCE_OUTCOMES,
        {
          count: summary.provisioningFileCount,
        },
        () => this.dependencies.provider.finalizeDerivedResources(context, plannedResources),
      )

      await this.runStep(
        context,
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

      const completed = await this.dependencies.repository.complete(context.operationId)

      state.markAggregateCompletionCommitted()
      this.publishTerminalResult(completed)
    } catch (error: unknown) {
      if (state.completionCommitted) {
        console.error(
          `[DestroyCapsuleExecutor] Capsule destroy '${operationId}' committed, but a later non-durable action failed. Preserving terminal state.`,
          error,
        )
        return
      }

      const failedPhase = state.currentFailurePhase
      const failedStepKey = state.currentStepKey

      await this.resolveFailure(context, state, plan, error, failedPhase, failedStepKey)
      throw error
    }
  }

  private async resolveFailure(
    context: DestroyCapsuleOperationContext,
    state: DestroyCapsuleExecutionState,
    plan: DestroyCapsulePlan | null,
    error: unknown,
    failedPhase: DestroyCapsuleFailurePhase,
    failedStepKey: DestroyCapsuleStepKey | null,
  ): Promise<void> {
    const summary = plan === null ? null : this.planner.summarize(plan)

    if (!state.providerIntentCommitted) {
      state.beginTerminalPhase(DestroyCapsuleFailurePhase.FAIL_BEFORE_PROVIDER_MUTATION)

      try {
        const failed = await this.dependencies.repository.failBeforeProviderMutation(
          context.operationId,
          error,
          createDestroyCapsuleFailureContext({
            operationId: context.operationId,
            capsuleId: context.capsuleId,
            phase: DestroyCapsuleFailurePhase.FAIL_BEFORE_PROVIDER_MUTATION,
            failedPhase,
            stepKey: failedStepKey,
            action: 'fail_destroy_before_provider_mutation',
            providerIntentCommitted: false,
            providerOwnershipUncertain: false,
            aggregateCompletionCommitted: false,
            branchCount: context.branches.length,
            instanceCount: summary?.instanceCount,
            volumeCount: summary?.volumeCount,
            provisioningFileCount: summary?.provisioningFileCount,
          }),
        )

        this.publishTerminalResult(failed)
        return
      } catch (terminalizationError: unknown) {
        console.error(`[DestroyCapsuleExecutor] Failed to terminalize pre-provider destroy failure for '${context.operationId}'.`, {
          destroyError: error,
          terminalizationError,
        })

        throw terminalizationError
      }
    }

    state.beginTerminalPhase(DestroyCapsuleFailurePhase.REQUIRE_CLEANUP)

    try {
      const cleanup = await this.dependencies.repository.requireCleanup(
        context.operationId,
        error,
        createDestroyCapsuleFailureContext({
          operationId: context.operationId,
          capsuleId: context.capsuleId,
          phase: DestroyCapsuleFailurePhase.REQUIRE_CLEANUP,
          failedPhase,
          stepKey: failedStepKey,
          action: 'mark_destroy_cleanup_required',
          providerIntentCommitted: true,
          providerOwnershipUncertain: true,
          aggregateCompletionCommitted: false,
          branchCount: context.branches.length,
          instanceCount: summary?.instanceCount,
          volumeCount: summary?.volumeCount,
          provisioningFileCount: summary?.provisioningFileCount,
        }),
      )

      this.publishTerminalResult(cleanup)
    } catch (terminalizationError: unknown) {
      console.error(`[DestroyCapsuleExecutor] Failed to persist cleanup-required state for destroy operation '${context.operationId}'.`, {
        destroyError: error,
        terminalizationError,
      })

      throw terminalizationError
    }
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
