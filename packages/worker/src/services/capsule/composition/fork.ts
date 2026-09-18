import { ForkAbandonment } from '../operations/fork/abandonment'
import { ForkCompensation } from '../operations/fork/compensation'
import { ForkExecutor } from '../operations/fork/executor'
import { ForkProvider } from '../operations/fork/provider'
import { ForkRepository } from '../operations/fork/persistence'
import { ForkSubmission } from '../operations/fork/submission'
import type { OperationSupervisor } from '../../../coordination'
import type {
  CapsuleBranchEventPublisher,
  CapsuleLifecycleEventPublisher,
  CapsuleOperationEventPublisher,
} from '../events'
import type { CapsuleOperationReader, CapsuleOperationStepStore } from '../operations/shared'
import type { CapsuleChannel, CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

export interface ComposeForkCapabilityOptions<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  persistence: CapsulePersistence<TDatabase, TTables>
  channel: CapsuleChannel
  supervisor: OperationSupervisor
  operationReader: CapsuleOperationReader<TDatabase, TTables>
  operationSteps: CapsuleOperationStepStore<TDatabase, TTables>
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
  branchEvents: CapsuleBranchEventPublisher
}

export interface ComposedForkCapability {
  submission: ForkSubmission
  abandonment: ForkAbandonment
}

/**
 * Composes the snapshot-fork vertical slice.
 *
 * Construction performs no SQL, provider mutation, scheduling, event
 * publication, or command registration. Fork provider execution remains
 * unavailable until it has independently safe resource accounting.
 */
export function composeForkCapability<TDatabase extends PostgresJsDatabase, TTables extends CapsuleTables>(
  options: ComposeForkCapabilityOptions<TDatabase, TTables>,
): ComposedForkCapability {
  const repository = new ForkRepository(options.persistence, options.operationReader)
  const provider = new ForkProvider()
  const compensation = new ForkCompensation()
  const executor = new ForkExecutor({
    repository,
    steps: options.operationSteps,
    provider,
    compensation,
    channel: options.channel,
    operationEvents: options.operationEvents,
    lifecycleEvents: options.lifecycleEvents,
    branchEvents: options.branchEvents,
  })
  const submission = new ForkSubmission(
    repository,
    executor,
    options.supervisor,
    options.operationEvents,
    options.lifecycleEvents,
    options.branchEvents,
  )
  const abandonment = new ForkAbandonment({
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
