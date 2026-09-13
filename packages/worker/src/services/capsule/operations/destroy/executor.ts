import { CapsuleSshAccessCommandName, TargetType } from '@qiln/core/server'
import { CapsuleOperationStepRunner } from '../shared'
import { DestroyExecutionState } from './execution/state'
import { destroyDiagnostics } from './execution/diagnostics'
import { DestroyStepKey } from './execution/steps'
import type { CapsuleChannel } from '@qiln/core/server'
import type { CapsuleOperationStepStore } from '../shared'
import type {
  CapsuleBranchEventPublisher,
  CapsuleLifecycleEventPublisher,
  CapsuleOperationEventPublisher,
} from '../../events'
import type { PreviewService } from '../../routing/preview'
import type { DestroyCapsuleOperationRepository } from './persistence/repository'
import type { DestroyResources } from './persistence/resources'
import type { DestroyCapsuleProvider } from './resource/provider'
import type { DestroyExecution, DestroyCapsuleTerminalResult } from './types'

export interface DestroyCapsuleExecutorDependencies {
  repository: DestroyCapsuleOperationRepository
  steps: CapsuleOperationStepStore
  resources: DestroyResources
  provider: DestroyCapsuleProvider
  channel: CapsuleChannel
  previews: PreviewService
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
  branchEvents: CapsuleBranchEventPublisher
}

/**
 * Executes one newly accepted destroy from durable PostgreSQL evidence.
 *
 * Every branch is assessed before deletion. Provider-free branches retain
 * truthful resource accounting while SSH and preview safety remain mandatory.
 */
export class DestroyCapsuleExecutor {
  private readonly runner: CapsuleOperationStepRunner

  constructor(private readonly dependencies: DestroyCapsuleExecutorDependencies) {
    this.runner = new CapsuleOperationStepRunner(dependencies.steps)
  }

  public async execute(operationId: string): Promise<void> {
    const state = new DestroyExecutionState()
    let execution: DestroyExecution | null = null
    try {
      const operation = await this.dependencies.repository.claim(operationId)
      this.dependencies.operationEvents.publishChanged(operation)
      const run = <TResult>(
        step: DestroyStepKey,
        metadata: Record<string, unknown>,
        action: () => Promise<TResult>,
      ): Promise<TResult> => {
        state.begin(step)
        return this.runner.run(
          {
            operationId,
            ownerId: operation.ownerId,
            capsuleId: operation.capsuleId,
            branchId: null,
            branchName: null,
            stepKey: step,
            metadata,
            failureContext: { operationType: 'destroy' },
          },
          action,
        )
      }

      const prepared = await run(DestroyStepKey.PLAN_DESTROY, {}, async () => {
        return await this.dependencies.repository.prepare(operationId)
      })
      execution = prepared

      await run(
        DestroyStepKey.REVOKE_SSH_ACCESS,
        { reason: 'capsule_destroy' },
        async () => {
          await this.dependencies.channel.command(CapsuleSshAccessCommandName.CAPSULE_ACCESS_REVOKE, {
            target: { type: TargetType.OWNER, id: prepared.ownerId },
            capsuleId: prepared.capsuleId,
            reason: 'capsule_destroy',
            operationId,
          })
        },
      )

      if (prepared.plan.providerRequired || prepared.withdrawPreviews) {
        state.enter('commit_provider_intent_fence')
        await this.dependencies.repository.fence(operationId)
        state.providerIntentConfirmed = true
      }

      await run(
        DestroyStepKey.WITHDRAW_PREVIEWS,
        { required: prepared.withdrawPreviews },
        async () => {
          if (prepared.withdrawPreviews) {
            await this.dependencies.previews.withdrawForDestroy(operationId)
          }
        },
      )
      await run(
        DestroyStepKey.DELETE_BRANCH_INSTANCES,
        { count: prepared.plan.instances.length },
        async () => {
          await this.dependencies.provider.deleteInstances(operationId, prepared.plan.instances)
        },
      )
      await run(
        DestroyStepKey.DELETE_BRANCH_VOLUMES,
        { count: prepared.plan.volumes.length },
        async () => {
          await this.dependencies.provider.deleteVolumes(operationId, prepared.plan.volumes)
        },
      )
      await run(
        DestroyStepKey.FINALIZE_DERIVED_RESOURCE_OUTCOMES,
        { count: prepared.plan.files.length },
        async () => {
          if (prepared.plan.files.length > 0) {
            await this.dependencies.resources.finalizeFiles(operationId)
          }
        },
      )
      await run(
        DestroyStepKey.VERIFY_TERMINAL_RESOURCE_OUTCOMES,
        { providerRequired: prepared.plan.providerRequired },
        async () => {
          await this.dependencies.repository.verify(operationId)
        },
      )

      state.enter('complete_destroy')
      const completed = await this.dependencies.repository.complete(operationId)
      state.completionConfirmed = true
      this.publish(completed)
    } catch (error: unknown) {
      if (state.completionConfirmed) {
        console.error('[DestroyCapsuleExecutor] Post-commit action failed; preserving completed destroy.', {
          operationId,
          error,
        })
        return
      }
      const classified = await this.dependencies.repository.classifyExecutionFailure(
        operationId,
        error,
        destroyDiagnostics(operationId, state, execution),
      )
      if (classified) {
        this.publish(classified)
        throw error
      }
    }
  }

  private publish(result: DestroyCapsuleTerminalResult): void {
    this.dependencies.operationEvents.publishChanged(result.operation)
    this.dependencies.lifecycleEvents.publishChanged(result.operation.ownerId, result.capsule)
    for (const branch of result.branches) {
      this.dependencies.branchEvents.publishStateChanged(
        result.operation.ownerId,
        branch.capsuleId,
        branch.name,
        branch.status,
      )
    }
  }
}
