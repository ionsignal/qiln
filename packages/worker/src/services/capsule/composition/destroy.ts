import { DestroyCapsuleAbandonmentHandler } from '../operations/destroy/abandonment'
import { DestroyCapsuleExecutor } from '../operations/destroy/executor'
import { DestroyCapsuleProvider } from '../operations/destroy/resource/provider'
import { DestroyCapsuleOperationRepository } from '../operations/destroy/persistence/repository'
import { DestroyCapsuleSubmissionService } from '../operations/destroy/submission'
import type { OperationSupervisor } from '../../../coordination/supervisor'
import type { IncusClient } from '../../../incus/client/index'
import type { CapsuleBranchEventPublisher } from '../events/branch'
import type { CapsuleLifecycleEventPublisher } from '../events/lifecycle'
import type { CapsuleOperationEventPublisher } from '../events/operation'
import type { CapsuleOperationReader } from '../operations/shared/operationReader'
import type { CapsuleOperationStepStore } from '../operations/shared/operationStepStore'
import type { CapsuleBranchResourceStore } from '../resource/store'
import type { CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

export interface ComposeDestroyCapabilityOptions<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  incus: IncusClient
  supervisor: OperationSupervisor
  operationReader: CapsuleOperationReader<TDatabase, TTables>
  operationSteps: CapsuleOperationStepStore<TDatabase, TTables>
  resources: CapsuleBranchResourceStore<TDatabase, TTables>
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
  branchEvents: CapsuleBranchEventPublisher
  persistence: CapsulePersistence<TDatabase, TTables>
}

export interface ComposedDestroyCapability {
  submission: DestroyCapsuleSubmissionService
  abandonment: DestroyCapsuleAbandonmentHandler
}

/**
 * Composes the destroy operation vertical slice.
 *
 * The same resource store instance is supplied to planning/accounting and
 * provider deletion. Durable ownership verification, deletion order, provider
 * intent, and failure classification remain operation-specific.
 */
export function composeDestroyCapability<TDatabase extends PostgresJsDatabase, TTables extends CapsuleTables>(
  options: ComposeDestroyCapabilityOptions<TDatabase, TTables>,
): ComposedDestroyCapability {
  const repository = new DestroyCapsuleOperationRepository(options.persistence, options.operationReader)
  const provider = new DestroyCapsuleProvider({
    incus: options.incus,
    resources: options.resources,
  })
  const executor = new DestroyCapsuleExecutor({
    repository,
    steps: options.operationSteps,
    resources: options.resources,
    provider,
    operationEvents: options.operationEvents,
    lifecycleEvents: options.lifecycleEvents,
    branchEvents: options.branchEvents,
  })
  const submission = new DestroyCapsuleSubmissionService(
    repository,
    executor,
    options.supervisor,
    options.operationEvents,
    options.lifecycleEvents,
    options.branchEvents,
  )
  const abandonment = new DestroyCapsuleAbandonmentHandler({
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
