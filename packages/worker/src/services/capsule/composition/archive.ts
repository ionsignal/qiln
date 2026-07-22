import type { CapsuleHostDbContract } from '@qiln/core/server'
import type { OperationSupervisor } from '../../../coordination/supervisor'
import type { CapsuleLifecycleEventPublisher } from '../events/lifecycle'
import type { CapsuleOperationEventPublisher } from '../events/operation'
import type { ProviderFreeArchivalOperationLedger } from '../operations/archival/shared/operationLedger'
import { CapsuleArchiveAbandonmentHandler } from '../operations/archival/archive/abandonment'
import { CapsuleArchiveExecutor } from '../operations/archival/archive/executor'
import { CapsuleArchiveRepository } from '../operations/archival/archive/repository'
import { CapsuleArchiveSubmissionService } from '../operations/archival/archive/submission'

export interface ComposeArchiveCapabilityOptions {
  db: CapsuleHostDbContract
  supervisor: OperationSupervisor
  operationLedger: ProviderFreeArchivalOperationLedger
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
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
export function composeArchiveCapability(options: ComposeArchiveCapabilityOptions): ComposedArchiveCapability {
  const repository = new CapsuleArchiveRepository(options.db, options.operationLedger)
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
