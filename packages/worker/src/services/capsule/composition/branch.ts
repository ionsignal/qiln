import { CapsuleOperationType } from '@qiln/core/server'
import { CapsuleBranchRuntimeObserver } from '../branch/observer'
import { CapsuleBranchRuntimeReconciler } from '../branch/reconciler'
import { CapsuleBranchRuntimeService } from '../branch/service'
import { CapsuleBranchStore } from '../branch/store'
import { BranchAbandonment } from '../operations/branch/abandonment'
import { BranchRepository } from '../operations/branch/persistence/repository'
import { BranchStartExecutor } from '../operations/branch/start/executor'
import { BranchStopExecutor } from '../operations/branch/stop/executor'
import { BranchSubmission } from '../operations/branch/submission'
import type { OperationSupervisor } from '../../../coordination'
import type { IncusClient } from '../../../incus/client/index'
import type { ProjectService } from '../../project'
import type { CapsuleBranchEventPublisher, CapsuleOperationEventPublisher } from '../events'
import type { CapsuleOperationReader, CapsuleOperationStepStore } from '../operations/shared'
import type { PreviewGate, PreviewService } from '../routing/preview'
import type { CapsuleChannel, CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

export interface ComposeBranchCapabilityOptions<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  persistence: CapsulePersistence<TDatabase, TTables>
  incus: IncusClient
  channel: CapsuleChannel
  project: ProjectService
  supervisor: OperationSupervisor
  operationReader: CapsuleOperationReader<TDatabase, TTables>
  operationSteps: CapsuleOperationStepStore<TDatabase, TTables>
  operationEvents: CapsuleOperationEventPublisher
  branchEvents: CapsuleBranchEventPublisher
  previews: PreviewService
  previewGate: PreviewGate<TDatabase, TTables>
}

export interface ComposedBranchCapability {
  service: CapsuleBranchRuntimeService
  start: BranchSubmission<'branch_start'>
  stop: BranchSubmission<'branch_stop'>
  abandonment: readonly [BranchAbandonment<'branch_start'>, BranchAbandonment<'branch_stop'>]
}

/**
 * Composes branch reads, observation-only reconciliation, and durable start and
 * stop capabilities around one runtime observer.
 *
 * Persistence, submission, and abandonment share discriminator-bound mechanics.
 * The two explicit executors retain their different provider, SSH, and preview
 * workflows. Construction performs no SQL, provider work, or scheduling.
 */
export function composeBranchCapability<TDatabase extends PostgresJsDatabase, TTables extends CapsuleTables>(
  options: ComposeBranchCapabilityOptions<TDatabase, TTables>,
): ComposedBranchCapability {
  const branchStore = new CapsuleBranchStore(options.persistence)
  const observer = new CapsuleBranchRuntimeObserver(options.incus, options.project)
  const reconciler = new CapsuleBranchRuntimeReconciler({
    branches: branchStore,
    events: options.branchEvents,
    observer,
  })
  const service = new CapsuleBranchRuntimeService({
    branches: branchStore,
    observer,
    reconciler,
  })
  const startRepository = new BranchRepository<'branch_start', TDatabase, TTables>({
    type: CapsuleOperationType.BRANCH_START,
    persistence: options.persistence,
    operations: options.operationReader,
  })
  const stopRepository = new BranchRepository<'branch_stop', TDatabase, TTables>({
    type: CapsuleOperationType.BRANCH_STOP,
    persistence: options.persistence,
    operations: options.operationReader,
    previews: options.previewGate,
  })
  const startExecutor = new BranchStartExecutor({
    repository: startRepository,
    steps: options.operationSteps,
    observer,
    previews: options.previews,
    incus: options.incus,
    project: options.project,
    channel: options.channel,
    operationEvents: options.operationEvents,
    branchEvents: options.branchEvents,
  })
  const stopExecutor = new BranchStopExecutor({
    repository: stopRepository,
    steps: options.operationSteps,
    observer,
    previews: options.previews,
    incus: options.incus,
    project: options.project,
    channel: options.channel,
    operationEvents: options.operationEvents,
    branchEvents: options.branchEvents,
  })
  const start = new BranchSubmission<'branch_start'>(
    startRepository,
    startExecutor,
    options.supervisor,
    options.operationEvents,
    options.branchEvents,
  )
  const stop = new BranchSubmission<'branch_stop'>(
    stopRepository,
    stopExecutor,
    options.supervisor,
    options.operationEvents,
    options.branchEvents,
  )
  const startAbandonment = new BranchAbandonment<'branch_start'>({
    repository: startRepository,
    operationEvents: options.operationEvents,
    branchEvents: options.branchEvents,
  })
  const stopAbandonment = new BranchAbandonment<'branch_stop'>({
    repository: stopRepository,
    operationEvents: options.operationEvents,
    branchEvents: options.branchEvents,
  })
  return {
    service,
    start,
    stop,
    abandonment: [startAbandonment, stopAbandonment],
  }
}
