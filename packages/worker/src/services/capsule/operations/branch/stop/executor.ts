import {
  CapsuleOperationType,
  CapsuleSshAccessCommandName,
  SshBranchAccessBlockReason,
  TargetType,
  type CapsuleChannel,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import type { IncusClient } from '../../../../../incus/client'
import type { ProjectService } from '../../../../project'
import type { CapsuleBranchRuntimeObserver } from '../../../branch'
import type { CapsuleBranchEventPublisher, CapsuleOperationEventPublisher } from '../../../events'
import type { PreviewService } from '../../../routing/preview'
import { branchInstanceName } from '../../../resource/identity'
import { CapsuleOperationStepRunner, type CapsuleOperationStepStore } from '../../shared'
import type { BranchRepository } from '../persistence/repository'
import type { BranchFailureDisposition, BranchTerminalResult } from '../types'

const BranchStopStep = {
  REVOKE_SSH: 'branch_stop_revoke_ssh',
  WITHDRAW_PREVIEWS: 'branch_stop_withdraw_previews',
  STOP_RUNTIME: 'branch_stop_runtime',
} as const

type BranchStopStep = (typeof BranchStopStep)[keyof typeof BranchStopStep]

export interface BranchStopExecutorDependencies {
  repository: BranchRepository<'branch_stop'>
  steps: CapsuleOperationStepStore
  observer: CapsuleBranchRuntimeObserver
  previews: PreviewService
  incus: IncusClient
  project: ProjectService
  channel: CapsuleChannel
  operationEvents: CapsuleOperationEventPublisher
  branchEvents: CapsuleBranchEventPublisher
}

export class BranchStopExecutor {
  private readonly stepRunner: CapsuleOperationStepRunner

  constructor(private readonly dependencies: BranchStopExecutorDependencies) {
    this.stepRunner = new CapsuleOperationStepRunner(dependencies.steps)
  }

  public async execute(operationId: string): Promise<void> {
    let phase = 'load_execution_input'
    let disposition: BranchFailureDisposition = 'pre_provider'
    let confirmedRuntimeIp: string | null | undefined
    let completed = false

    try {
      const input = await this.dependencies.repository.load(operationId)

      phase = 'claim_operation'
      const running = await this.dependencies.repository.claim(operationId)
      this.dependencies.operationEvents.publishChanged(running)

      const runStep = <TResult>(
        stepKey: BranchStopStep,
        metadata: Record<string, unknown>,
        action: () => Promise<TResult>,
      ): Promise<TResult> => {
        phase = stepKey
        return this.stepRunner.run(
          {
            operationId: input.operationId,
            capsuleId: input.capsuleId,
            ownerId: input.ownerId,
            branchId: input.branchId,
            branchName: input.branchName,
            stepKey,
            metadata,
            failureContext: {
              operationType: CapsuleOperationType.BRANCH_STOP,
              action: stepKey,
            },
          },
          action,
        )
      }

      await runStep(
        BranchStopStep.REVOKE_SSH,
        {
          branchId: input.branchId,
          reason: SshBranchAccessBlockReason.BRANCH_STOP,
        },
        async () => {
          const result = await this.dependencies.channel.command(CapsuleSshAccessCommandName.BRANCH_ACCESS_REVOKE, {
            target: {
              type: TargetType.OWNER,
              id: input.ownerId,
            },
            capsuleId: input.capsuleId,
            branchId: input.branchId,
            reason: SshBranchAccessBlockReason.BRANCH_STOP,
          })

          if (!result.revocation?.relayClosureConfirmed) {
            throw new IncusError('Host SSH policy did not confirm branch relay closure.', 'CONFLICT', {
              operationId,
              branchId: input.branchId,
            })
          }
        },
      )

      await runStep(
        BranchStopStep.WITHDRAW_PREVIEWS,
        {
          branchId: input.branchId,
        },
        async () => {
          await this.dependencies.previews.withdrawBranch(input.ownerId, input.capsuleId, input.branchId)
        },
      )

      phase = 'commit_provider_intent'
      await this.dependencies.repository.intent(operationId)
      disposition = 'cleanup_required'

      await runStep(
        BranchStopStep.STOP_RUNTIME,
        {
          branchId: input.branchId,
          branchName: input.branchName,
        },
        async () => {
          let providerError: unknown

          try {
            const namespace = this.dependencies.project.getNamespace(input.ownerId)
            await this.dependencies.incus.project(namespace).instances.stop(branchInstanceName(input.branchId))
          } catch (error: unknown) {
            providerError = error
          }

          const observation = await this.dependencies.observer.observe(input.ownerId, input.branchId)

          if (observation.kind === 'confirmed' && observation.status === 'offline') {
            return
          }

          if (observation.kind === 'confirmed' && observation.status === 'online') {
            disposition = 'previous_confirmed'
            confirmedRuntimeIp = observation.runtimeIp
            throw (
              providerError ??
              new IncusError('Incus did not confirm the branch offline after the stop request.', 'CONFLICT', {
                operationId,
                branchId: input.branchId,
                providerStatus: observation.providerStatus,
              })
            )
          }

          disposition = 'cleanup_required'
          throw new IncusError(
            'The branch runtime state could not be positively confirmed after the stop request.',
            'API_ERROR',
            {
              operationId,
              branchId: input.branchId,
              observationKind: observation.kind,
              providerError:
                providerError instanceof Error
                  ? {
                      name: providerError.name,
                      message: providerError.message,
                    }
                  : providerError === undefined
                    ? null
                    : {
                        value: providerError,
                      },
            },
          )
        },
      )

      phase = 'complete_operation'
      const result = await this.dependencies.repository.complete(operationId)
      completed = true
      this.dependencies.operationEvents.publishChanged(result.operation)
      if (result.branch && result.branchChanged) {
        this.dependencies.branchEvents.publishStateChanged(
          result.operation.ownerId,
          result.branch.capsuleId,
          result.branch.name,
          result.branch.status,
        )
      }
    } catch (error: unknown) {
      if (completed) {
        console.error(
          `[BranchStopExecutor] Branch stop '${operationId}' completed, but post-commit handling failed.`,
          error,
        )
        return
      }
      const result = await this.dependencies.repository.fail({
        operationId,
        error,
        phase,
        disposition,
        ...(confirmedRuntimeIp === undefined ? {} : { runtimeIp: confirmedRuntimeIp }),
      })
      this.publishFailure(result)
      throw error
    }
  }

  private publishFailure(result: BranchTerminalResult): void {
    this.dependencies.operationEvents.publishChanged(result.operation)
    if (result.branch && result.branchChanged) {
      this.dependencies.branchEvents.publishStateChanged(
        result.operation.ownerId,
        result.branch.capsuleId,
        result.branch.name,
        result.branch.status,
      )
    }
  }
}
