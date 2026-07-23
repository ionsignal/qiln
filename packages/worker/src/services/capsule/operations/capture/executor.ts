import {
  CapsuleOperationType,
  CapsuleSnapshotLimitation,
  CapsuleSnapshotMode,
  type CapsuleSnapshotLimitationValue,
} from '@qiln/core/server'
import { IncusError } from '../../../../errors'
import { CapsuleOperationStepRunner } from '../shared'
import { CaptureStepKey } from './steps'
import type { IncusClient } from '../../../../incus/client/index'
import type { CapsuleOperationStepStore } from '../shared'
import type {
  CapsuleBranchEventPublisher,
  CapsuleLifecycleEventPublisher,
  CapsuleOperationEventPublisher,
} from '../../events'
import type { CaptureCollector } from './collect'
import type { CaptureGitCollector } from './git'
import type { CaptureProvider } from './provider'
import type { CaptureRepository } from './persistence'
import type { CaptureCommitResult, CaptureExecutionInput, CaptureResourceRecord, CaptureTerminalResult } from './types'

export interface CaptureExecutorDependencies {
  repository: CaptureRepository
  steps: CapsuleOperationStepStore
  provider: CaptureProvider
  collector: CaptureCollector
  git: CaptureGitCollector
  incus: IncusClient
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
  branchEvents: CapsuleBranchEventPublisher
}

type CapturePhase =
  | 'load'
  | 'claim'
  | 'intent'
  | typeof CaptureStepKey.SNAPSHOT
  | typeof CaptureStepKey.COLLECT
  | typeof CaptureStepKey.GIT
  | typeof CaptureStepKey.COMMIT

/**
 * Executes one experimental Snapshot Capture from immutable PostgreSQL input.
 *
 * The executor receives only an operation ID. It never retains command input,
 * consults the mutable blueprint registry, discovers provider resources, or
 * resumes abandoned work.
 */
export class CaptureExecutor {
  private readonly runner: CapsuleOperationStepRunner

  constructor(private readonly dependencies: CaptureExecutorDependencies) {
    this.runner = new CapsuleOperationStepRunner(dependencies.steps)
  }

  public async execute(operationId: string): Promise<void> {
    let execution: CaptureExecutionInput | null = null
    let phase: CapturePhase = 'load'
    let providerIntentCommitted = false
    let commitCompleted = false

    try {
      const capture = await this.dependencies.repository.load(operationId)
      execution = capture
      if (capture.requestedMode !== CapsuleSnapshotMode.EXPERIMENTAL) {
        throw new IncusError('Capture executor received an unsupported Snapshot Capture mode.', 'CONFLICT', {
          operationId,
          requestedMode: capture.requestedMode,
        })
      }

      phase = 'claim'

      const running = await this.dependencies.repository.claim(operationId)
      this.dependencies.operationEvents.publishChanged(running.operation)

      phase = 'intent'

      await this.dependencies.repository.intent(operationId)
      providerIntentCommitted = true

      phase = CaptureStepKey.SNAPSHOT

      await this.run(
        capture,
        CaptureStepKey.SNAPSHOT,
        {
          rootCount: capture.plan.roots.length,
        },
        async () => {
          await this.dependencies.provider.create(capture)
        },
      )

      phase = CaptureStepKey.COLLECT

      const collection = await this.run(
        capture,
        CaptureStepKey.COLLECT,
        {
          rootCount: capture.plan.roots.length,
          collectionSource: 'source_volume',
        },
        async () => {
          const projects = new Set(capture.plan.roots.map(root => root.project))
          if (projects.size !== 1) {
            throw new IncusError(
              'Experimental Snapshot Capture requires every artifact root to use one Incus project.',
              'CONFLICT',
              {
                operationId,
                projects: [...projects],
              },
            )
          }
          const projectName = capture.plan.roots[0]?.project
          if (!projectName) {
            throw new IncusError('Experimental Snapshot Capture has no managed artifact root.', 'CONFLICT', {
              operationId,
            })
          }
          const project = this.dependencies.incus.UseProject(projectName)
          return await this.dependencies.collector.collect({
            operationId,
            policy: capture.capturePolicy,
            roots: capture.plan.roots,
            files: project.storage.files,
          })
        },
      )
      phase = CaptureStepKey.GIT
      const git = await this.run(
        capture,
        CaptureStepKey.GIT,
        {
          repositoryCount: capture.capturePolicy.gitRepositories.length,
          implementation: 'omitted',
        },
        async () => {
          return await this.dependencies.git.collect({
            operationId,
            policy: capture.capturePolicy,
          })
        },
      )
      const limitations = this.limitations(collection.limitations, git.limitations)
      phase = CaptureStepKey.COMMIT
      const committed = await this.run(
        capture,
        CaptureStepKey.COMMIT,
        {
          manifestDigest: collection.digest,
          entryCount: collection.entryCount,
          totalBytes: collection.totalBytes,
          limitations,
        },
        async () => {
          const result = await this.dependencies.repository.commit({
            execution: capture,
            collection: {
              ...collection,
              limitations,
            },
            git,
          })
          // Set this before step accounting resumes so a later accounting
          // failure cannot trigger compensation for committed snapshot state.
          commitCompleted = true
          return result
        },
      )
      this.publish(committed)
    } catch (error: unknown) {
      if (commitCompleted) {
        console.error(
          `[CaptureExecutor] Snapshot Capture '${operationId}' committed, but post-commit accounting or invalidation failed.`,
          error,
        )
        return
      }
      await this.fail(operationId, execution, phase, providerIntentCommitted, error)
      throw error
    }
  }

  private limitations(
    collection: readonly CapsuleSnapshotLimitationValue[],
    git: readonly CapsuleSnapshotLimitationValue[],
  ): CapsuleSnapshotLimitationValue[] {
    const limitations = new Set<CapsuleSnapshotLimitationValue>([
      ...collection,
      ...git,
      CapsuleSnapshotLimitation.DEPENDENCY_EVIDENCE_OMITTED,
      CapsuleSnapshotLimitation.SOURCE_VOLUME_COLLECTION,
      CapsuleSnapshotLimitation.SECRET_POLICY_UNVERIFIED,
    ])
    return [...limitations]
  }

  private async fail(
    operationId: string,
    execution: CaptureExecutionInput | null,
    phase: CapturePhase,
    providerIntentCommitted: boolean,
    error: unknown,
  ): Promise<void> {
    const context: Record<string, unknown> = {
      operationId,
      capsuleId: execution?.capsuleId,
      sourceBranchId: execution?.sourceBranchId,
      phase: 'experimental_snapshot_capture_execution_failure',
      failedPhase: phase,
      providerIntentCommitted,
    }
    if (!providerIntentCommitted) {
      const terminal = await this.dependencies.repository.classify(operationId, error, context)
      if (terminal) {
        this.publish(terminal)
      }
      return
    }
    const resources = await this.dependencies.repository.resources.list(operationId)
    const compensation = await this.dependencies.provider.compensate(operationId, resources)
    if (compensation.complete) {
      try {
        const terminal = await this.dependencies.repository.compensated(operationId, error, {
          ...context,
          compensationAttempted: true,
          compensationComplete: true,
          compensatedResourceIds: compensation.resources.map(resource => resource.id),
        })
        this.publish(terminal)
        return
      } catch (terminalizationError: unknown) {
        console.error(
          `[CaptureExecutor] Provider compensation completed for '${operationId}', but ordinary failure terminalization failed.`,
          {
            captureError: error,
            terminalizationError,
          },
        )
        const terminal = await this.dependencies.repository.classify(operationId, terminalizationError, {
          ...context,
          compensationAttempted: true,
          compensationComplete: true,
          compensatedFailureTerminalizationFailed: true,
        })
        if (terminal) {
          this.publish(terminal)
        }
        return
      }
    }

    const terminal = await this.dependencies.repository.classify(operationId, error, {
      ...context,
      compensationAttempted: true,
      compensationComplete: false,
      compensationFailures: compensation.failures,
      captureResources: resources.map(resource => this.describeResource(resource)),
    })

    if (terminal) {
      this.publish(terminal)
    }
  }

  private describeResource(resource: CaptureResourceRecord): Record<string, unknown> {
    return {
      resourceId: resource.id,
      artifactRootId: resource.artifactRootId,
      status: resource.status,
      snapshotIntentAt: resource.snapshotIntentAt?.toISOString() ?? null,
      snapshotCreatedAt: resource.snapshotCreatedAt?.toISOString() ?? null,
      cleanupIntentAt: resource.cleanupIntentAt?.toISOString() ?? null,
      cleanupCompletedAt: resource.cleanupCompletedAt?.toISOString() ?? null,
    }
  }

  private async run<TResult>(
    execution: CaptureExecutionInput,
    stepKey: CaptureStepKey,
    metadata: Record<string, unknown>,
    action: () => Promise<TResult>,
  ): Promise<TResult> {
    return await this.runner.run(
      {
        operationId: execution.operationId,
        capsuleId: execution.capsuleId,
        ownerId: execution.ownerId,
        branchId: execution.sourceBranchId,
        branchName: execution.sourceBranchName,
        stepKey,
        metadata,
        failureContext: {
          operationType: CapsuleOperationType.SNAPSHOT_CAPTURE,
          action: 'execute_experimental_snapshot_capture_step',
        },
      },
      action,
    )
  }

  private publish(result: CaptureTerminalResult | CaptureCommitResult): void {
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
