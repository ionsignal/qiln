import { CapsuleSshAccessCommandName, TargetType, type CapsuleChannel } from '@qiln/core/server'
import { CapsuleOperationStepRunner } from '../shared'
import { DestroyExecutionState } from './execution/state'
import { destroyDiagnostics } from './execution/diagnostics'
import { DestroyStepKey } from './execution/steps'
import type { CapsuleOperationStepStore } from '../shared'
import type {
  CapsuleBranchEventPublisher,
  CapsuleLifecycleEventPublisher,
  CapsuleOperationEventPublisher,
} from '../../events'
import type { DestroyCapsuleOperationRepository } from './persistence/repository'
import type { DestroyTargets } from './persistence/targets'
import type { DestroyCapsuleProvider } from './resource/provider'
import type { DestroyRoutes } from './resource/routes'
import type { DestroyExecution, DestroyCapsuleTerminalResult } from './types'

export interface DestroyCapsuleExecutorDependencies {
  repository: DestroyCapsuleOperationRepository
  targets: DestroyTargets
  steps: CapsuleOperationStepStore
  provider: DestroyCapsuleProvider
  routes: DestroyRoutes
  channel: CapsuleChannel
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
  branchEvents: CapsuleBranchEventPublisher
}

/**
 * A new attempt may recover old failures but never resumes their execution.
 *
 * Access closure precedes provider mutation; ingress closure precedes upstream
 * removal. Each provider obligation is settled in this attempt's target ledger.
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
      const run = <TResult>(step: DestroyStepKey, action: () => Promise<TResult>): Promise<TResult> => {
        state.begin(step)
        return this.runner.run({
          operationId,
          ownerId: operation.ownerId,
          capsuleId: operation.capsuleId,
          branchId: null,
          branchName: null,
          stepKey: step,
          metadata: {},
          failureContext: { operationType: 'destroy' },
        }, action)
      }
      const prepared = await run(DestroyStepKey.PLAN_DESTROY, () =>
        this.dependencies.repository.prepare(operationId),
      )
      execution = prepared
      await run(DestroyStepKey.REVOKE_SSH_ACCESS, async () => {
        const report = await this.dependencies.channel.command(CapsuleSshAccessCommandName.CAPSULE_ACCESS_REVOKE, {
          target: { type: TargetType.OWNER, id: prepared.ownerId },
          capsuleId: prepared.capsuleId,
          reason: 'capsule_destroy',
          operationId,
        })
        await this.dependencies.targets.recordRevocation(operationId, report)
      })
      if (prepared.targets.length > 0) {
        state.enter('commit_provider_intent_fence')
        await this.dependencies.repository.fence(operationId)
        state.providerIntentConfirmed = true
      }
      await run(DestroyStepKey.WITHDRAW_ROUTES, async () => {
        await this.dependencies.routes.withdraw(prepared)
        await this.dependencies.repository.withdrawn(operationId)
      })
      await run(DestroyStepKey.DELETE_BRANCH_INSTANCES, () =>
        this.dependencies.provider.instances(prepared),
      )
      await run(DestroyStepKey.DELETE_MANAGED_STORAGE, () =>
        this.dependencies.provider.storage(prepared),
      )
      await run(DestroyStepKey.VERIFY_TERMINAL_RESOURCE_OUTCOMES, async () => {
        state.enter('complete_destroy')
        const completed = await this.dependencies.repository.complete(operationId)
        state.completionConfirmed = true
        this.publish(completed)
      })
    } catch (error: unknown) {
      if (state.completionConfirmed) {
        console.error('[DestroyCapsuleExecutor] Post-commit accounting failed; preserving completed destroy.', {
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
