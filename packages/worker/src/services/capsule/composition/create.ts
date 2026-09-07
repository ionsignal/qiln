import { CreateCapsuleAbandonmentHandler } from '../operations/create/abandonment'
import { CreateCapsuleExecutor } from '../operations/create/executor'
import { CreateCapsuleAcceptance } from '../operations/create/persistence/acceptance'
import { CreateCapsuleClassification } from '../operations/create/persistence/classification'
import { CreateCapsuleCompletion } from '../operations/create/persistence/completion'
import { CreateCapsuleExecution } from '../operations/create/persistence/execution'
import { CreateCapsuleLocks } from '../operations/create/persistence/locks'
import { CreateCapsuleOperationRepository } from '../operations/create/persistence/repository'
import { CreateCapsuleLineagePolicy } from '../operations/create/policy/lineage'
import { CreateCapsuleCompensation } from '../operations/create/resource/compensate'
import { CreateCapsuleResourcePlanner } from '../operations/create/resource/plan'
import { CreateCapsuleProvisioner } from '../operations/create/resource/provision'
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
import type { CapsuleBlueprintRegistry, CapsuleChannel, CapsulePersistence, CapsuleTables } from '@qiln/core/server'

export interface ComposeCreateCapabilityOptions<
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
  resources: CapsuleBranchResourceStore<TDatabase, TTables>
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
  branchEvents: CapsuleBranchEventPublisher
  persistence: CapsulePersistence<TDatabase, TTables>
}

export interface ComposedCreateCapability {
  submission: CreateCapsuleSubmissionService
  abandonment: CreateCapsuleAbandonmentHandler
}

/**
 * Composes the create operation vertical slice.
 *
 * Construction performs no SQL, provider mutation, operation scheduling, event
 * publication, or command registration.
 */
export function composeCreateCapability<TDatabase extends PostgresJsDatabase, TTables extends CapsuleTables>(
  options: ComposeCreateCapabilityOptions<TDatabase, TTables>,
): ComposedCreateCapability {
  const lineage = new CreateCapsuleLineagePolicy<TTables>()
  const locks = new CreateCapsuleLocks(options.persistence)
  const planner = new CreateCapsuleResourcePlanner()
  const acceptance = new CreateCapsuleAcceptance(options.persistence, options.operationReader, locks, lineage)
  const execution = new CreateCapsuleExecution(options.persistence, locks, lineage)
  const completion = new CreateCapsuleCompletion(options.persistence, locks, lineage, planner, options.project)
  const classification = new CreateCapsuleClassification(options.persistence, locks, lineage)
  const repository = new CreateCapsuleOperationRepository({
    acceptance,
    execution,
    completion,
    classification,
  })
  const driver = new CapsuleResourceDriver(options.incus, options.project)
  const provisioner = new CreateCapsuleProvisioner({
    resources: options.resources,
    driver,
  })
  const compensator = new CreateCapsuleCompensation({
    resources: options.resources,
    driver,
  })
  const executor = new CreateCapsuleExecutor({
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
  const submission = new CreateCapsuleSubmissionService(
    repository,
    executor,
    options.supervisor,
    options.blueprints,
    options.incus.images,
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
