import { CapsuleArchiveAbandonmentHandler } from '../operations/archival/archive/abandonment'
import { CapsuleArchiveExecutor } from '../operations/archival/archive/executor'
import { CapsuleArchiveRepository } from '../operations/archival/archive/repository'
import { CapsuleArchiveSubmissionService } from '../operations/archival/archive/submission'
import type { OperationSupervisor } from '../../../coordination/supervisor'
import type { CapsuleLifecycleEventPublisher } from '../events/lifecycle'
import type { CapsuleOperationEventPublisher } from '../events/operation'
import type { ProviderFreeArchivalOperationLedger } from '../operations/archival/shared/operationLedger'
import type { PreviewGate } from '../routing/preview/gate'
import type { CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

export interface ComposeArchiveCapabilityOptions<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  supervisor: OperationSupervisor
  operationLedger: ProviderFreeArchivalOperationLedger<TDatabase, TTables>
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
  previewGate: PreviewGate<TDatabase, TTables>
  persistence: CapsulePersistence<TDatabase, TTables>
}

export interface ComposedArchiveCapability {
  submission: CapsuleArchiveSubmissionService
  abandonment: CapsuleArchiveAbandonmentHandler
}

/**
 * Composes the provider-free archive operation vertical slice.
 *
 * Archive lifecycle eligibility, timestamp policy, terminal classification, and
 * abandonment policy remain owned by the archive repository and handler.
 */
export function composeArchiveCapability<TDatabase extends PostgresJsDatabase, TTables extends CapsuleTables>(
  options: ComposeArchiveCapabilityOptions<TDatabase, TTables>,
): ComposedArchiveCapability {
  const repository = new CapsuleArchiveRepository(options.persistence, options.operationLedger, options.previewGate)
  const executor = new CapsuleArchiveExecutor({
    repository,
    operationEvents: options.operationEvents,
    lifecycleEvents: options.lifecycleEvents,
  })
  const submission = new CapsuleArchiveSubmissionService(
    repository,
    executor,
    options.supervisor,
    options.operationEvents,
    options.lifecycleEvents,
  )
  const abandonment = new CapsuleArchiveAbandonmentHandler({
    repository,
    operationEvents: options.operationEvents,
    lifecycleEvents: options.lifecycleEvents,
  })
  return {
    submission,
    abandonment,
  }
}
