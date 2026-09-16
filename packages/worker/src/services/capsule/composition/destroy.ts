import { DestroyCapsuleAbandonmentHandler } from '../operations/destroy/abandonment'
import { DestroyCapsuleExecutor } from '../operations/destroy/executor'
import { DestroyPlanner } from '../operations/destroy/plan'
import { DestroyCapsuleProvider } from '../operations/destroy/resource/provider'
import { DestroyRoutes } from '../operations/destroy/resource/routes'
import { DestroyCapsuleOperationRepository } from '../operations/destroy/persistence/repository'
import { DestroyTargets } from '../operations/destroy/persistence/targets'
import { DestroyCapsuleSubmissionService } from '../operations/destroy/submission'
import type { CaddyClient } from '../../../caddy'
import type { OperationSupervisor } from '../../../coordination/supervisor'
import type { IncusClient } from '../../../incus/client'
import type { ProjectService } from '../../project'
import type { CapsuleBranchEventPublisher } from '../events/branch'
import type { CapsuleLifecycleEventPublisher } from '../events/lifecycle'
import type { CapsuleOperationEventPublisher } from '../events/operation'
import type { CapsuleOperationStepStore } from '../operations/shared/operationStepStore'
import type { CapsuleChannel, CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

export interface ComposeDestroyCapabilityOptions<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  incus: IncusClient
  caddy: CaddyClient
  caddyServer: string
  channel: CapsuleChannel
  project: ProjectService
  supervisor: OperationSupervisor
  operationSteps: CapsuleOperationStepStore<TDatabase, TTables>
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
 * Destroy owns proof, planning, provider outcomes, and retirement. It does not
 * reuse create accounting transitions or ordinary preview reconciliation.
 */
export function composeDestroyCapability<TDatabase extends PostgresJsDatabase, TTables extends CapsuleTables>(
  options: ComposeDestroyCapabilityOptions<TDatabase, TTables>,
): ComposedDestroyCapability {
  const targets = new DestroyTargets(options.persistence)
  const planner = new DestroyPlanner(options.persistence, options.caddyServer)
  const repository = new DestroyCapsuleOperationRepository(options.persistence, planner, targets)
  const provider = new DestroyCapsuleProvider({
    incus: options.incus,
    projects: options.project,
    targets,
  })
  const routes = new DestroyRoutes(options.persistence, options.caddy, targets)
  const executor = new DestroyCapsuleExecutor({
    repository,
    targets,
    steps: options.operationSteps,
    provider,
    routes,
    channel: options.channel,
    operationEvents: options.operationEvents,
    lifecycleEvents: options.lifecycleEvents,
    branchEvents: options.branchEvents,
  })
  return {
    submission: new DestroyCapsuleSubmissionService(
      repository,
      executor,
      options.supervisor,
      options.operationEvents,
      options.lifecycleEvents,
      options.branchEvents,
    ),
    abandonment: new DestroyCapsuleAbandonmentHandler({
      repository,
      operationEvents: options.operationEvents,
      lifecycleEvents: options.lifecycleEvents,
      branchEvents: options.branchEvents,
    }),
  }
}
