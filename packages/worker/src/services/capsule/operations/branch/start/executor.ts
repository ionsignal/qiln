import {
  CapsuleChannelError,
  CapsuleChannelErrorCode,
  CapsuleOperationType,
  CapsuleSshAccessCommandName,
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

const BranchStartStep = {
  START_RUNTIME: 'branch_start_runtime',
  ENABLE_SSH: 'branch_start_enable_ssh',
  RESUME_PREVIEWS: 'branch_start_resume_previews',
} as const

type BranchStartStep = (typeof BranchStartStep)[keyof typeof BranchStartStep]

export interface BranchStartExecutorDependencies {
  repository: BranchRepository<'branch_start'>
  steps: CapsuleOperationStepStore
  observer: CapsuleBranchRuntimeObserver
  previews: PreviewService
  incus: IncusClient
  project: ProjectService
  channel: CapsuleChannel
  operationEvents: CapsuleOperationEventPublisher
  branchEvents: CapsuleBranchEventPublisher
}

export class BranchStartExecutor {
  private readonly stepRunner: CapsuleOperationStepRunner

  constructor(private readonly dependencies: BranchStartExecutorDependencies) {
    this.stepRunner = new CapsuleOperationStepRunner(dependencies.steps)
  }

  public async execute(operationId: string): Promise<void> {
    let phase = 'load_execution_input'
    let disposition: BranchFailureDisposition = 'pre_provider'
    let completed = false

    try {
      const input = await this.dependencies.repository.load(operationId)

      phase = 'claim_operation'
      const running = await this.dependencies.repository.claim(operationId)
      this.dependencies.operationEvents.publishChanged(running)

      const runStep = <TResult>(
        stepKey: BranchStartStep,
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
              operationType: CapsuleOperationType.BRANCH_START,
              action: stepKey,
            },
          },
          action,
        )
      }

      phase = 'commit_provider_intent'
      await this.dependencies.repository.intent(operationId)
      disposition = 'cleanup_required'

      await runStep(
        BranchStartStep.START_RUNTIME,
        {
          branchId: input.branchId,
          branchName: input.branchName,
        },
        async () => {
          let providerError: unknown

          try {
            const namespace = this.dependencies.project.getNamespace(input.ownerId)
            await this.dependencies.incus.project(namespace).instances.start(branchInstanceName(input.branchId))
          } catch (error: unknown) {
            providerError = error
          }

          const observation = await this.dependencies.observer.observe(input.ownerId, input.branchId)

          if (observation.kind === 'confirmed' && observation.status === 'online') {
            const branch = await this.dependencies.repository.online(operationId, observation.runtimeIp)
            this.dependencies.branchEvents.publishStateChanged(
              input.ownerId,
              input.capsuleId,
              branch.name,
              branch.status,
            )
            return
          }

          if (observation.kind === 'confirmed' && observation.status === 'offline') {
            disposition = 'previous_confirmed'
            throw (
              providerError ??
              new IncusError('Incus did not confirm the branch online after the start request.', 'CONFLICT', {
                operationId,
                branchId: input.branchId,
                providerStatus: observation.providerStatus,
              })
            )
          }

          disposition = 'cleanup_required'
          throw new IncusError(
            'The branch runtime state could not be positively confirmed after the start request.',
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

      await runStep(
        BranchStartStep.ENABLE_SSH,
        {
          branchId: input.branchId,
        },
        async () => {
          try {
            await this.dependencies.channel.command(CapsuleSshAccessCommandName.BRANCH_ACCESS_ENABLE, {
              target: {
                type: TargetType.OWNER,
                id: input.ownerId,
              },
              capsuleId: input.capsuleId,
              branchId: input.branchId,
            })
          } catch (error: unknown) {
            if (this.isSshDisabled(error)) {
              return
            }
            throw error
          }
        },
      )

      await runStep(
        BranchStartStep.RESUME_PREVIEWS,
        {
          branchId: input.branchId,
        },
        async () => {
          await this.dependencies.previews.resumeBranch(input.ownerId, input.capsuleId, input.branchId)
        },
      )

      phase = 'complete_operation'
      const result = await this.dependencies.repository.complete(operationId)
      completed = true
      this.dependencies.operationEvents.publishChanged(result.operation)
    } catch (error: unknown) {
      if (completed) {
        console.error(
          `[BranchStartExecutor] Branch start '${operationId}' completed, but post-commit handling failed.`,
          error,
        )
        return
      }
      const result = await this.dependencies.repository.fail({
        operationId,
        error,
        phase,
        disposition,
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

  private isSshDisabled(error: unknown): boolean {
    if (
      !(error instanceof CapsuleChannelError) ||
      error.code !== CapsuleChannelErrorCode.FORBIDDEN ||
      typeof error.details !== 'object' ||
      error.details === null ||
      Array.isArray(error.details)
    ) {
      return false
    }
    return (error.details as Record<string, unknown>).feature === 'ssh_access'
  }
}
