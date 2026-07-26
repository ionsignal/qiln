import { CreateCapsuleAbandonmentHandler } from '../operations/create/abandonment'
import { CreateCapsuleExecutor } from '../operations/create/executor'
import { CreateCapsuleOperationRepository } from '../operations/create/repository'
import { CreateCapsuleSubmissionService } from '../operations/create/submission'
import { CapsuleResourceDriver } from '../resource/driver'
import type { OperationSupervisor } from '../../../coordination/supervisor'
import type { IncusClient } from '../../../incus/client/index'
import type { ProjectService } from '../../project'
import type { CapsuleBranchEventPublisher } from '../events/branch'
import type { CapsuleLifecycleEventPublisher } from '../events/lifecycle'
import type { CapsuleOperationEventPublisher } from '../events/operation'
import type { CapsuleOperationReader } from '../operations/shared/operationReader'
import type { CapsuleOperationStepStore } from '../operations/shared/operationStepStore'
import type { CapsuleBranchResourceStore } from '../resource/store'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { CapsuleBlueprintRegistry, QilnPersistence, QilnTables } from '@qiln/core/server'

export interface ComposeCreateCapabilityOptions<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends QilnTables = QilnTables,
> {
  incus: IncusClient
  project: ProjectService
  blueprints: CapsuleBlueprintRegistry
  supervisor: OperationSupervisor
  operationReader: CapsuleOperationReader<TDatabase, TTables>
  operationSteps: CapsuleOperationStepStore<TDatabase, TTables>
  resources: CapsuleBranchResourceStore<TDatabase, TTables>
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
  branchEvents: CapsuleBranchEventPublisher
  persistence: QilnPersistence<TDatabase, TTables>
}

export interface ComposedCreateCapability {
  submission: CreateCapsuleSubmissionService
  abandonment: CreateCapsuleAbandonmentHandler
}

/**
 * Composes the create operation vertical slice.
 *
 * This function only constructs objects. It performs no SQL, provider mutation,
 * operation scheduling, event publication, or command registration.
 */
export function composeCreateCapability<TDatabase extends PostgresJsDatabase, TTables extends QilnTables>(
  options: ComposeCreateCapabilityOptions<TDatabase, TTables>,
): ComposedCreateCapability {
  const repository = new CreateCapsuleOperationRepository(options.persistence, options.operationReader)
  const resourceDriver = new CapsuleResourceDriver(options.incus, options.project)
  const executor = new CreateCapsuleExecutor({
    repository,
    steps: options.operationSteps,
    resources: options.resources,
    driver: resourceDriver,
    project: options.project,
    operationEvents: options.operationEvents,
    lifecycleEvents: options.lifecycleEvents,
    branchEvents: options.branchEvents,
  })
  const submission = new CreateCapsuleSubmissionService(
    repository,
    executor,
    options.supervisor,
    options.blueprints,
    options.operationEvents,
    options.lifecycleEvents,
    options.branchEvents,
  )
  const abandonment = new CreateCapsuleAbandonmentHandler({
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
