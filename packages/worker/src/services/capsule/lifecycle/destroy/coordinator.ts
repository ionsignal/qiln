import {
  CapsuleDestroyOutputSchema,
  CapsuleLifecycleOperationRequestHashSchema,
  digestCanonicalJsonValue,
  type CapsuleDestroyOutput,
  type CapsuleLifecycleOperationRequestHash,
} from '@qiln/core/server'
import { IncusError } from '../../../../errors'
import { InlineLifecycleStepExecutor } from '../../lifecycleLedger/executor'
import { CapsuleDestroyExecutionState } from './executionState'
import { CapsuleDestroyFailurePhase, createCapsuleDestroyOperationFailureContext } from './failureContext'
import { CapsuleDestroyPlanner } from './planner'
import { CapsuleDestroyProviderPhase } from './provider'
import { CapsuleDestroyStepKey } from './stepKeys'
import type { CapsuleBranchEventPublisher } from '../../branch/events'
import type { CapsuleLifecycleEventPublisher } from '../events'
import type {
  CapsuleBranchResourceStore,
  CapsuleBranchStore,
  CapsuleLifecycleOperationStepStore,
  CapsuleLifecycleOperationStore,
} from '../../stores'
import type { IncusClient } from '../../../../incus/client/index'
import type { CapsuleDestroyContext, CapsuleDestroyInput, CapsuleDestroyPlan } from './types'

interface CapsuleDestroyRequestHashInput {
  operationType: 'destroy'
  capsuleId: string
}

export interface CapsuleDestroyCoordinatorDependencies {
  operations: CapsuleLifecycleOperationStore
  steps: CapsuleLifecycleOperationStepStore
  branches: CapsuleBranchStore
  resources: CapsuleBranchResourceStore
  incus: IncusClient
  branchEvents: CapsuleBranchEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
}

function createDestroyRequestHash(capsuleId: string): CapsuleLifecycleOperationRequestHash {
  const digest = digestCanonicalJsonValue(
    {
      operationType: 'destroy',
      capsuleId,
    } satisfies CapsuleDestroyRequestHashInput,
    {
      context: 'capsule destroy request',
    },
  )

  return CapsuleLifecycleOperationRequestHashSchema.parse(digest)
}

/**
 * Coordinates terminal capsule retirement.
 *
 * Destroy is an inline, non-compensating, fail-closed mutation. Durable rows record accounting
 * and provider fences but never authorize retries or resume.
 */
export class CapsuleDestroyCoordinator {
  private readonly stepExecutor: InlineLifecycleStepExecutor
  private readonly planner = new CapsuleDestroyPlanner()
  private readonly provider: CapsuleDestroyProviderPhase

  constructor(private readonly dependencies: CapsuleDestroyCoordinatorDependencies) {
    this.stepExecutor = new InlineLifecycleStepExecutor(dependencies.steps)
    this.provider = new CapsuleDestroyProviderPhase({
      incus: dependencies.incus,
      resources: dependencies.resources,
    })
  }

  public async execute(input: CapsuleDestroyInput): Promise<CapsuleDestroyOutput> {
    const requestHash = createDestroyRequestHash(input.capsuleId)
    const existing = await this.dependencies.operations.findExistingDestroyOperationReceipt(input.ownerId, input.idempotencyKey, requestHash)
    if (existing) {
      return existing
    }
    const accepted = await this.dependencies.operations.acceptDestroyOperation({
      ownerId: input.ownerId,
      capsuleId: input.capsuleId,
      idempotencyKey: input.idempotencyKey,
      requestHash,
    })
    if ('replayedReceipt' in accepted) {
      const replayed = await this.dependencies.operations.findExistingDestroyOperationReceipt(input.ownerId, input.idempotencyKey, requestHash)
      if (!replayed) {
        throw new IncusError('Replayed capsule destroy operation could not be reloaded.', 'API_ERROR', {
          ownerId: input.ownerId,
          capsuleId: input.capsuleId,
          idempotencyKey: input.idempotencyKey,
          operationId: accepted.replayedReceipt.operationId,
        })
      }
      return replayed
    }
    const context: CapsuleDestroyContext = {
      operationId: accepted.operationId,
      ownerId: input.ownerId,
      capsuleId: accepted.capsuleId,
      branches: accepted.branches,
    }
    for (const branch of context.branches) {
      this.dependencies.branchEvents.publishStateChanged(context.ownerId, context.capsuleId, branch.name, 'destroying')
    }
    const state = new CapsuleDestroyExecutionState(CapsuleDestroyFailurePhase.PLAN_DESTROY)
    let plan: CapsuleDestroyPlan | null = null
    const runStep = async <TResult>(
      stepKey: CapsuleDestroyStepKey,
      metadata: Record<string, unknown>,
      action: () => Promise<TResult> | TResult,
    ): Promise<TResult> => {
      state.beginStep(stepKey)
      return await this.stepExecutor.run(
        {
          operationId: context.operationId,
          capsuleId: context.capsuleId,
          ownerId: context.ownerId,
          branchId: null,
          branchName: null,
          stepKey,
          metadata,
        },
        action,
      )
    }
    try {
      plan = await runStep(
        CapsuleDestroyStepKey.PLAN_DESTROY,
        {
          branchCount: context.branches.length,
        },
        async () => {
          const rows = await this.dependencies.resources.listBranchResourceInventories(context.branches.map(branch => branch.id))
          return this.planner.createPlan(context.ownerId, context.capsuleId, context.branches, rows)
        },
      )
      const summary = this.planner.summarize(plan)
      await runStep(
        CapsuleDestroyStepKey.DELETE_BRANCH_INSTANCES,
        {
          count: summary.instanceCount,
        },
        () => this.provider.deleteInstances(context, plan!.instances),
      )
      await runStep(
        CapsuleDestroyStepKey.DELETE_BRANCH_VOLUMES,
        {
          count: summary.volumeCount,
        },
        () => this.provider.deleteVolumes(context, plan!.volumes),
      )
      await runStep(
        CapsuleDestroyStepKey.FINALIZE_DERIVED_RESOURCE_OUTCOMES,
        {
          count: summary.provisioningFileCount,
        },
        () => this.provider.finalizeDerivedResources(context, plan!),
      )
      await runStep(
        CapsuleDestroyStepKey.VERIFY_TERMINAL_RESOURCE_OUTCOMES,
        {
          resourceCount: plan.resourceIds.size,
        },
        async () => {
          const rows = await this.dependencies.resources.listBranchResourceInventories(plan!.branches.map(branchPlan => branchPlan.branch.id))
          this.planner.verifyTerminalOutcomes(plan!, rows)
        },
      )
      state.beginTerminalPhase(CapsuleDestroyFailurePhase.FINALIZE_DESTROYED_AGGREGATE)
      const result = await this.dependencies.operations.finalizeDestroyOperation(context.ownerId, context.capsuleId, context.operationId)
      state.markAggregateDestroyed()
      for (const branch of context.branches) {
        this.dependencies.branchEvents.publishStateChanged(context.ownerId, context.capsuleId, branch.name, 'destroyed')
      }
      this.dependencies.lifecycleEvents.publishChanged(context.ownerId, {
        capsuleId: result.capsuleId,
        lifecycleStatus: result.lifecycleStatus,
        archivedAt: result.archivedAt,
        destroyedAt: result.destroyedAt,
      })
      return CapsuleDestroyOutputSchema.parse(result)
    } catch (error: unknown) {
      await this.resolveFailure(context, state, plan, error)
      throw error
    }
  }

  private async resolveFailure(
    context: CapsuleDestroyContext,
    state: CapsuleDestroyExecutionState,
    plan: CapsuleDestroyPlan | null,
    error: unknown,
  ): Promise<void> {
    if (state.aggregateDestroyed) {
      console.error(
        `[CapsuleDestroyCoordinator] Capsule '${context.capsuleId}' committed destroyed, but a later non-durable action failed. Preserving terminal state.`,
        error,
      )
      return
    }
    const summary = plan === null ? null : this.planner.summarize(plan)
    const failureContext = createCapsuleDestroyOperationFailureContext({
      operationId: context.operationId,
      capsuleId: context.capsuleId,
      phase: state.currentFailurePhase,
      stepKey: state.currentStepKey,
      aggregateFinalized: false,
      aggregateDestroyed: false,
      action:
        state.currentFailurePhase === CapsuleDestroyFailurePhase.FINALIZE_DESTROYED_AGGREGATE
          ? 'finalize_destroyed_capsule_aggregate'
          : undefined,
      branchCount: context.branches.length,
      instanceCount: summary?.instanceCount,
      volumeCount: summary?.volumeCount,
      provisioningFileCount: summary?.provisioningFileCount,
    })
    try {
      const marked = await this.dependencies.operations.markLifecycleOperationAndAggregateCleanupRequired(
        context.ownerId,
        context.capsuleId,
        context.operationId,
        error,
        failureContext,
      )
      if (!marked) {
        return
      }
      for (const branch of context.branches) {
        this.dependencies.branchEvents.publishStateChanged(context.ownerId, context.capsuleId, branch.name, 'cleanup_required')
      }
    } catch (databaseError: unknown) {
      console.error(
        `[CapsuleDestroyCoordinator] Failed to mark capsule '${context.capsuleId}' destroy operation '${context.operationId}' cleanup_required.`,
        {
          destroyError: error,
          databaseError,
        },
      )
    }
  }
}
