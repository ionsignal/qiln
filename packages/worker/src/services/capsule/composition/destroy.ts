import { DestroyCapsuleAbandonmentHandler } from '../operations/destroy/abandonment'
import { DestroyCapsuleExecutor } from '../operations/destroy/executor'
import { DestroyCapsuleProvider } from '../operations/destroy/resource/provider'
import { DestroyCapsuleOperationRepository } from '../operations/destroy/persistence/repository'
import { DestroyResources } from '../operations/destroy/persistence/resources'
import { DestroyCapsuleSubmissionService } from '../operations/destroy/submission'
import { CapsuleResourceProvenance } from '../resource/provenance'
import { CreateResourcePlanner } from '../resource/plan'
import { RouteGate } from '../routing/gate'
import type { OperationSupervisor } from '../../../coordination/supervisor'
import type { IncusClient } from '../../../incus/client'
import type { ProjectService } from '../../project'
import type { CapsuleBranchEventPublisher } from '../events/branch'
import type { CapsuleLifecycleEventPublisher } from '../events/lifecycle'
import type { CapsuleOperationEventPublisher } from '../events/operation'
import type { CapsuleOperationStepStore } from '../operations/shared/operationStepStore'
import type { PreviewGate } from '../routing/preview/gate'
import type { PreviewService } from '../routing/preview/service'
import type { CapsuleChannel, CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

export interface ComposeDestroyCapabilityOptions<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  incus: IncusClient
  channel: CapsuleChannel
  project: ProjectService
  previews: PreviewService
  supervisor: OperationSupervisor
  operationSteps: CapsuleOperationStepStore<TDatabase, TTables>
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
  branchEvents: CapsuleBranchEventPublisher
  previewGate: PreviewGate<TDatabase, TTables>
  persistence: CapsulePersistence<TDatabase, TTables>
}

export interface ComposedDestroyCapability {
  submission: DestroyCapsuleSubmissionService
  abandonment: DestroyCapsuleAbandonmentHandler
}

/**
 * Composes destroy-owned persistence around read-only immutable create proof.
 *
 * Create and destroy share deterministic planning, not resource transitions or
 * operation policy. Fork provenance remains unsupported and fails closed.
 */
export function composeDestroyCapability<TDatabase extends PostgresJsDatabase, TTables extends CapsuleTables>(
  options: ComposeDestroyCapabilityOptions<TDatabase, TTables>,
): ComposedDestroyCapability {
  const provenance = new CapsuleResourceProvenance(
    options.persistence,
    new CreateResourcePlanner(),
    options.project,
  )
  const resources = new DestroyResources(options.persistence, provenance)
  const routes = new RouteGate(options.persistence)
  const repository = new DestroyCapsuleOperationRepository(
    options.persistence,
    resources,
    options.previewGate,
    routes,
  )
  const provider = new DestroyCapsuleProvider({
    incus: options.incus,
    resources,
  })
  const executor = new DestroyCapsuleExecutor({
    repository,
    steps: options.operationSteps,
    resources,
    provider,
    channel: options.channel,
    previews: options.previews,
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
