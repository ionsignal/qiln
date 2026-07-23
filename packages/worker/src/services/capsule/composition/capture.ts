import type { CapsuleHostDbContract } from '@qiln/core/server'
import { CaptureCollector } from '../operations/capture/collect'
import { CaptureExecutor } from '../operations/capture/executor'
import { CaptureGitCollector } from '../operations/capture/git'
import { CaptureProvider } from '../operations/capture/provider'
import { CaptureSubmission } from '../operations/capture/submission'
import { CaptureAbandonment } from '../operations/capture/abandonment'
import { CapturePlanner } from '../operations/capture/plan'
import { CaptureRepository } from '../operations/capture/persistence'
import type { OperationSupervisor } from '../../../coordination/supervisor'
import type { IncusClient } from '../../../incus/client/index'
import type { CapsuleBranchEventPublisher } from '../events/branch'
import type { CapsuleLifecycleEventPublisher } from '../events/lifecycle'
import type { CapsuleOperationEventPublisher } from '../events/operation'
import type { CapsuleOperationReader, CapsuleOperationStepStore } from '../operations/shared'

export interface ComposeCaptureCapabilityOptions {
  db: CapsuleHostDbContract
  incus: IncusClient
  supervisor: OperationSupervisor
  operationReader: CapsuleOperationReader
  operationSteps: CapsuleOperationStepStore
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
  branchEvents: CapsuleBranchEventPublisher
  enabled: boolean
}

export interface ComposedCaptureCapability {
  submission: CaptureSubmission
  abandonment: CaptureAbandonment
}

/**
 * Composes the experimental Snapshot Capture vertical slice.
 *
 * Construction performs no SQL, provider mutation, command registration,
 * scheduling, collection, or event publication.
 */
export function composeCaptureCapability(options: ComposeCaptureCapabilityOptions): ComposedCaptureCapability {
  const planner = new CapturePlanner()
  const repository = new CaptureRepository(options.db, options.operationReader, planner)
  const provider = new CaptureProvider({
    incus: options.incus,
    resources: repository.resources,
  })
  const collector = new CaptureCollector()
  const git = new CaptureGitCollector()
  const executor = new CaptureExecutor({
    repository,
    steps: options.operationSteps,
    provider,
    collector,
    git,
    incus: options.incus,
    operationEvents: options.operationEvents,
    lifecycleEvents: options.lifecycleEvents,
    branchEvents: options.branchEvents,
  })
  const submission = new CaptureSubmission(
    repository,
    executor,
    options.supervisor,
    options.operationEvents,
    options.lifecycleEvents,
    options.branchEvents,
    {
      enabled: options.enabled,
    },
  )
  const abandonment = new CaptureAbandonment({
    repository,
    operationEvents: options.operationEvents,
    lifecycleEvents: options.lifecycleEvents,
    branchEvents: options.branchEvents,
  })
  return {
    submission,
    abandonment,
  }
}
