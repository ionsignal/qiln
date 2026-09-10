import {
  CapsuleOperationType,
  CapsuleSshAccessCommandName,
  SshBranchAccessBlockReason,
  TargetType,
  type CapsuleChannel,
} from '@qiln/core/server'
import { IncusError } from '../../../../errors'
import { CapsuleOperationStepRunner } from '../shared/operationStepRunner'
import { SnapshotStep } from './steps'
import type {
  CapsuleBranchEventPublisher,
  CapsuleLifecycleEventPublisher,
  CapsuleOperationEventPublisher,
} from '../../events'
import type { CapsuleOperationStepStore } from '../shared/operationStepStore'
import type { SnapshotRepository } from './persistence'
import type { SnapshotProvider } from './provider'
import type { SnapshotExecution, SnapshotRuntimeEvidence, SnapshotTransition } from './types'

export interface SnapshotExecutorDependencies {
  repository: SnapshotRepository
  provider: SnapshotProvider
  channel: CapsuleChannel
  steps: CapsuleOperationStepStore
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
  branchEvents: CapsuleBranchEventPublisher
}

/**
 * Executes one newly accepted Create Snapshot operation.
 *
 * Finalization uncertainty prohibits compensation because the snapshot
 * transaction may have committed even when its acknowledgement was lost.
 *
 * Host access remains blocked on every outcome. Runtime evidence and snapshot
 * cleanup evidence are independent inputs to failure classification.
 */
export class SnapshotExecutor {
  private readonly runner: CapsuleOperationStepRunner

  constructor(private readonly dependencies: SnapshotExecutorDependencies) {
    this.runner = new CapsuleOperationStepRunner(dependencies.steps)
  }

  public async execute(operationId: string): Promise<void> {
    let claimed = false
    let providerStarted = false
    let finalizationStarted = false
    let completed = false
    const state: {
      execution: SnapshotExecution | null
      runtime: SnapshotRuntimeEvidence
    } = {
      execution: null,
      runtime: 'unobserved',
    }
    try {
      const running = await this.dependencies.repository.claim(operationId)
      claimed = true
      this.publish(running.transition)
      const execution = running.execution
      state.execution = execution
      await this.step(execution, SnapshotStep.REVOKE_SSH, async () => {
        const result = await this.dependencies.channel.command(CapsuleSshAccessCommandName.BRANCH_ACCESS_REVOKE, {
          target: {
            type: TargetType.OWNER,
            id: execution.ownerId,
          },
          capsuleId: execution.capsuleId,
          branchId: execution.sourceBranchId,
          reason: SshBranchAccessBlockReason.SNAPSHOT_CREATE,
        })
        if (
          result.access.capsuleId !== execution.capsuleId ||
          result.access.branchId !== execution.sourceBranchId ||
          result.access.state !== 'blocked' ||
          result.revocation?.relayClosureConfirmed !== true
        ) {
          throw new IncusError('Host SSH policy did not confirm blocked branch access and relay closure.', 'CONFLICT', {
            operationId,
            branchId: execution.sourceBranchId,
          })
        }
      })
      await this.step(execution, SnapshotStep.VERIFY, async () => {
        state.runtime = 'uncertain'
        await this.dependencies.provider.verify(execution)
        state.runtime = 'offline'
      })
      await this.step(execution, SnapshotStep.CREATE, async () => {
        providerStarted = true
        await this.dependencies.provider.create(execution)
      })
      await this.step(execution, SnapshotStep.COMMIT, async () => {
        state.runtime = 'uncertain'
        await this.dependencies.provider.offline(execution)
        state.runtime = 'offline'
        finalizationStarted = true
        const committed = await this.dependencies.repository.commit(operationId)
        completed = true
        this.publish(committed)
      })
    } catch (error: unknown) {
      if (completed) {
        console.error('[SnapshotExecutor] Snapshot committed but subsequent accounting failed.', {
          operationId,
          error,
        })
        return
      }
      // An unsuccessful claim cannot prove that this invocation owns an
      // executor. Startup abandonment handles accepted operations left behind.
      if (!claimed) {
        throw error
      }
      let compensated = false
      if (providerStarted && !finalizationStarted) {
        try {
          const result = await this.dependencies.provider.compensate(operationId)
          compensated = result.complete
          if (!result.complete) {
            console.error('[SnapshotExecutor] Snapshot compensation is incomplete.', {
              operationId,
              failures: result.failures,
            })
          }
        } catch (compensationError: unknown) {
          console.error('[SnapshotExecutor] Snapshot compensation could not be proven.', {
            operationId,
            compensationError,
          })
        }
        // Removing snapshots does not prove the source is still offline. An
        // earlier failed offline check remains uncertain even after cleanup.
        if (state.execution !== null && state.runtime === 'offline') {
          state.runtime = 'uncertain'
          try {
            await this.dependencies.provider.offline(state.execution)
            state.runtime = 'offline'
          } catch (runtimeError: unknown) {
            console.error('[SnapshotExecutor] Source runtime could not be confirmed offline after compensation.', {
              operationId,
              runtimeError,
            })
          }
        }
      }
      const terminal = await this.dependencies.repository.fail({
        operationId,
        error,
        origin: 'live',
        runtime: state.runtime,
        compensated,
        finalizationAttempted: finalizationStarted,
      })
      if (terminal) {
        this.publish(terminal)
      }
      throw error
    }
  }

  private async step(execution: SnapshotExecution, stepKey: SnapshotStep, action: () => Promise<void>): Promise<void> {
    await this.runner.run(
      {
        operationId: execution.operationId,
        capsuleId: execution.capsuleId,
        ownerId: execution.ownerId,
        branchId: execution.sourceBranchId,
        branchName: execution.sourceBranchName,
        stepKey,
        metadata: {
          managedVolumeCount: execution.plan.volumes.length,
        },
        failureContext: {
          operationType: CapsuleOperationType.SNAPSHOT_CREATE,
        },
      },
      action,
    )
  }

  private publish(result: SnapshotTransition): void {
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
