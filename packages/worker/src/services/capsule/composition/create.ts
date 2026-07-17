import type { CapsuleBlueprintRegistry, CapsuleHostDbContract } from '@qiln/core/server'
import type { OperationSupervisor } from '../../../coordination/supervisor'
import type { IncusClient } from '../../../incus/client/index'
import type { ProjectService } from '../../project'
import type { CapsuleBranchEventPublisher } from '../events/branch'
import type { CapsuleLifecycleEventPublisher } from '../events/lifecycle'
import type { CapsuleOperationEventPublisher } from '../events/operation'
import type { CapsuleOperationReader } from '../operations/shared/operationReader'
import type { CapsuleOperationStepStore } from '../operations/shared/operationStepStore'
import type { CapsuleBranchResourceStore } from '../stores/branchResourceStore'
import { CreateCapsuleAbandonmentHandler } from '../operations/create/abandonment'
import { CreateCapsuleExecutor } from '../operations/create/executor'
import { CreateCapsuleOperationRepository } from '../operations/create/repository'
import { CreateCapsuleSubmissionService } from '../operations/create/submission'
import { CapsuleResourceDriver } from '../resources/driver'

export interface ComposeCreateCapabilityOptions {
  db: CapsuleHostDbContract
  incus: IncusClient
  project: ProjectService
  blueprints: CapsuleBlueprintRegistry
  supervisor: OperationSupervisor
  operationReader: CapsuleOperationReader
  operationSteps: CapsuleOperationStepStore
  resources: CapsuleBranchResourceStore
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
  branchEvents: CapsuleBranchEventPublisher
}

export interface ComposedCreateCapability {
  submission: CreateCapsuleSubmissionService
  abandonment: CreateCapsuleAbandonmentHandler
}

/**
 * Composes the create operation vertical slice.
 *
 * This function only constructs objects. It performs no SQL, provider
 * mutation, operation scheduling, event publication, or command registration.
 */
export function composeCreateCapability(options: ComposeCreateCapabilityOptions): ComposedCreateCapability {
  const repository = new CreateCapsuleOperationRepository(options.db, options.operationReader)
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
