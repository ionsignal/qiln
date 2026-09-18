import { CapsuleCreateAbandonmentHandler } from '../operations/create/abandonment'
import { CapsuleCreateExecutor } from '../operations/create/executor'
import { CapsuleCreateAcceptance } from '../operations/create/persistence/acceptance'
import { CapsuleCreateClassification } from '../operations/create/persistence/classification'
import { CapsuleCreateCompletion } from '../operations/create/persistence/completion'
import { CapsuleCreateExecution } from '../operations/create/persistence/execution'
import { CapsuleCreateLocks } from '../operations/create/persistence/locks'
import { CapsuleCreateRepository } from '../operations/create/persistence/repository'
import { CapsuleCreateInventoryPolicy } from '../operations/create/policy/inventory'
import { CapsuleCreateCompensation } from '../operations/create/resource/compensate'
import { CapsuleCreateResourceLineage } from '../operations/create/resource/lineage'
import { CapsuleCreateResourcePlanner } from '../operations/create/resource/plan'
import { CapsuleCreateProvisioner } from '../operations/create/resource/provision'
import { CapsuleCreateResourceStore } from '../operations/create/resource/store'
import { CapsuleCreateSubmissionService } from '../operations/create/submission'
import { CapsuleResourceDriver } from '../resource/driver'
import type { OperationSupervisor } from '../../../coordination/supervisor'
import type { IncusClient } from '../../../incus/client/index'
import type { ProjectService } from '../../project'
import type { CapsuleBranchEventPublisher } from '../events/branch'
import type { CapsuleLifecycleEventPublisher } from '../events/lifecycle'
import type { CapsuleOperationEventPublisher } from '../events/operation'
import type { CapsuleOperationReader } from '../operations/shared/operationReader'
import type { CapsuleOperationStepStore } from '../operations/shared/operationStepStore'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { CapsuleBlueprintRegistry, CapsuleChannel, CapsulePersistence, CapsuleTables } from '@qiln/core/server'

export interface ComposeCapsuleCreateCapabilityOptions<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  incus: IncusClient
  channel: CapsuleChannel
  project: ProjectService
  blueprints: CapsuleBlueprintRegistry
  supervisor: OperationSupervisor
  operationReader: CapsuleOperationReader<TDatabase, TTables>
  operationSteps: CapsuleOperationStepStore<TDatabase, TTables>
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
  branchEvents: CapsuleBranchEventPublisher
  persistence: CapsulePersistence<TDatabase, TTables>
}

export interface ComposedCapsuleCreateCapability<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  submission: CapsuleCreateSubmissionService<TDatabase, TTables>
  abandonment: CapsuleCreateAbandonmentHandler<TDatabase, TTables>
}

/**
 * Composes the create operation vertical slice.
 *
 * Construction performs no SQL, provider mutation, operation scheduling, event
 * publication, or command registration.
 */
export function composeCapsuleCreateCapability<TDatabase extends PostgresJsDatabase, TTables extends CapsuleTables>(
  options: ComposeCapsuleCreateCapabilityOptions<TDatabase, TTables>,
): ComposedCapsuleCreateCapability<TDatabase, TTables> {
  const lineage = new CapsuleCreateResourceLineage<TTables>()
  const locks = new CapsuleCreateLocks(options.persistence)
  const planner = new CapsuleCreateResourcePlanner()
  const inventory = new CapsuleCreateInventoryPolicy<TTables>(planner, options.project)
  const resources = new CapsuleCreateResourceStore(options.persistence)
  const acceptance = new CapsuleCreateAcceptance(options.persistence, options.operationReader, locks, lineage)
  const execution = new CapsuleCreateExecution(options.persistence, locks, lineage, inventory)
  const completion = new CapsuleCreateCompletion(options.persistence, locks, lineage, inventory)
  const classification = new CapsuleCreateClassification(options.persistence, locks, lineage, inventory)
  const repository = new CapsuleCreateRepository({
    acceptance,
    execution,
    completion,
    classification,
  })
  const driver = new CapsuleResourceDriver(options.incus, options.project)
  const provisioner = new CapsuleCreateProvisioner({
    resources,
    driver,
  })
  const compensator = new CapsuleCreateCompensation({
    resources,
    driver,
  })
  const executor = new CapsuleCreateExecutor({
    repository,
    steps: options.operationSteps,
    planner,
    provisioner,
    compensator,
    project: options.project,
    channel: options.channel,
    operationEvents: options.operationEvents,
    lifecycleEvents: options.lifecycleEvents,
    branchEvents: options.branchEvents,
  })
  const submission = new CapsuleCreateSubmissionService(
    repository,
    executor,
    options.supervisor,
    options.blueprints,
    options.incus.images,
    options.operationEvents,
    options.lifecycleEvents,
    options.branchEvents,
  )
  const abandonment = new CapsuleCreateAbandonmentHandler({
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
