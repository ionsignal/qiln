import { CapsuleUnarchiveAbandonmentHandler } from '../operations/archival/unarchive/abandonment'
import { CapsuleUnarchiveExecutor } from '../operations/archival/unarchive/executor'
import { CapsuleUnarchiveRepository } from '../operations/archival/unarchive/repository'
import { CapsuleUnarchiveSubmissionService } from '../operations/archival/unarchive/submission'
import type { OperationSupervisor } from '../../../coordination/supervisor'
import type { CapsuleLifecycleEventPublisher } from '../events/lifecycle'
import type { CapsuleOperationEventPublisher } from '../events/operation'
import type { ProviderFreeArchivalOperationLedger } from '../operations/archival/shared/operationLedger'
import type { QilnPersistence, QilnTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

export interface ComposeUnarchiveCapabilityOptions<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends QilnTables = QilnTables,
> {
  supervisor: OperationSupervisor
  operationLedger: ProviderFreeArchivalOperationLedger<TDatabase, TTables>
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
  persistence: QilnPersistence<TDatabase, TTables>
}

export interface ComposedUnarchiveCapability {
  submission: CapsuleUnarchiveSubmissionService
  abandonment: CapsuleUnarchiveAbandonmentHandler
}

/**
 * Composes the provider-free unarchive operation vertical slice.
 *
 * Exact archive-timestamp preservation and unarchive-specific terminal policy
 * remain explicit within the unarchive repository.
 */
export function composeUnarchiveCapability<TDatabase extends PostgresJsDatabase, TTables extends QilnTables>(
  options: ComposeUnarchiveCapabilityOptions<TDatabase, TTables>,
): ComposedUnarchiveCapability {
  const repository = new CapsuleUnarchiveRepository(options.persistence, options.operationLedger)
  const executor = new CapsuleUnarchiveExecutor({
    repository,
    operationEvents: options.operationEvents,
    lifecycleEvents: options.lifecycleEvents,
  })
  const submission = new CapsuleUnarchiveSubmissionService(
    repository,
    executor,
    options.supervisor,
    options.operationEvents,
    options.lifecycleEvents,
  )
  const abandonment = new CapsuleUnarchiveAbandonmentHandler({
    repository,
    operationEvents: options.operationEvents,
    lifecycleEvents: options.lifecycleEvents,
  })
  return {
    submission,
    abandonment,
  }
}
