import { CapsuleBranchProvenance } from '../branch/provenance'
import { CommittedRouteService } from '../routing/service'
import { CommittedRouteStore } from '../routing/store'
import { PreviewRouteController } from '../routing/preview/controller'
import { PreviewHost } from '../routing/preview/host'
import { PreviewPlanner } from '../routing/preview/plan'
import { PreviewProbe } from '../routing/preview/probe'
import { PreviewReconciliationCoordinator } from '../routing/preview/reconciliation'
import { PreviewService } from '../routing/preview/service'
import { PreviewRepository } from '../routing/preview/persistence'
import { RouteOperationAbandonmentClassifier } from '../operations/routing/classification'
import { createRouteOperationAbandonmentHandlers } from '../operations/routing/abandonment'
import type { CapsuleOperationAbandonmentHandler } from '../operations/abandonment'
import type {
  CapsuleOperationEventPublisher,
  CapsulePreviewEventPublisher,
  CapsuleRouteEventPublisher,
} from '../events'
import type { CaddyClient } from '../../../caddy'
import type { WorkerRoutingConfig } from '../../../types'
import type { CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

const DEFAULT_PREVIEW_VERIFICATION_TIMEOUT_MS = 10_000

export interface ComposeRoutingCapabilityOptions<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  persistence: CapsulePersistence<TDatabase, TTables>
  caddy: CaddyClient
  routing: WorkerRoutingConfig
  operationEvents: CapsuleOperationEventPublisher
  previewEvents: CapsulePreviewEventPublisher
  routeEvents: CapsuleRouteEventPublisher
}

export interface ComposedRoutingCapability {
  service: CommittedRouteService
  preview: PreviewService
  reconciliation: PreviewReconciliationCoordinator
  abandonment: readonly CapsuleOperationAbandonmentHandler[]
}

export function composeRoutingCapability<TDatabase extends PostgresJsDatabase, TTables extends CapsuleTables>(
  options: ComposeRoutingCapabilityOptions<TDatabase, TTables>,
): ComposedRoutingCapability {
  const committedRoutes = new CommittedRouteStore(options.persistence)
  const service = new CommittedRouteService(committedRoutes)
  const repository = new PreviewRepository(options.persistence)
  const provenance = new CapsuleBranchProvenance(options.persistence)
  const controller = new PreviewRouteController({
    provenance,
    repository,
    host: new PreviewHost(options.routing.baseDomain),
    planner: new PreviewPlanner(),
    probe: new PreviewProbe({
      ingressEndpoint: options.routing.ingressEndpoint,
      timeoutMs: options.routing.verificationTimeoutMs ?? DEFAULT_PREVIEW_VERIFICATION_TIMEOUT_MS,
    }),
    caddy: options.caddy,
    events: options.previewEvents,
  })
  const reconciliation = new PreviewReconciliationCoordinator({
    repository,
    controller,
  })
  const preview = new PreviewService({
    repository,
    reconciliation,
  })
  const classifier = new RouteOperationAbandonmentClassifier(options.persistence)
  const abandonment = createRouteOperationAbandonmentHandlers({
    classifier,
    operationEvents: options.operationEvents,
    routeEvents: options.routeEvents,
  })

  return {
    service,
    preview,
    reconciliation,
    abandonment,
  }
}
