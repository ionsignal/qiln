import { CapsuleBranchProvenance } from '../branch/provenance'
import { CapsuleRouteService } from '../routing/service'
import { CapsuleRouteStore } from '../routing/store'
import { PreviewHost } from '../routing/preview/host'
import { PreviewPlanner } from '../routing/preview/plan'
import { PreviewProbe } from '../routing/preview/probe'
import { PreviewService } from '../routing/preview/service'
import { PreviewStore } from '../routing/preview/store'
import { RouteOperationClassification } from '../operations/routing/classification'
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

const DEFAULT_PREVIEW_RECONCILE_INTERVAL_MS = 15_000
const DEFAULT_PREVIEW_VERIFICATION_TIMEOUT_MS = 10_000

export interface ComposeRoutingCapabilityOptions<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  persistence: CapsulePersistence<TDatabase, TTables>
  caddy: CaddyClient
  routing: WorkerRoutingConfig
  reconcileBranches: () => Promise<void>
  operationEvents: CapsuleOperationEventPublisher
  previewEvents: CapsulePreviewEventPublisher
  routeEvents: CapsuleRouteEventPublisher
}

export interface ComposedRoutingCapability {
  service: CapsuleRouteService
  preview: PreviewService
  abandonment: readonly CapsuleOperationAbandonmentHandler[]
}

export function composeRoutingCapability<TDatabase extends PostgresJsDatabase, TTables extends CapsuleTables>(
  options: ComposeRoutingCapabilityOptions<TDatabase, TTables>,
): ComposedRoutingCapability {
  const routes = new CapsuleRouteStore(options.persistence)
  const service = new CapsuleRouteService(routes)
  const previews = new PreviewStore(options.persistence)
  const provenance = new CapsuleBranchProvenance(options.persistence)
  const preview = new PreviewService({
    store: previews,
    provenance,
    host: new PreviewHost(options.routing.baseDomain),
    planner: new PreviewPlanner(),
    probe: new PreviewProbe({
      ingressEndpoint: options.routing.ingressEndpoint,
      timeoutMs: options.routing.verificationTimeoutMs ?? DEFAULT_PREVIEW_VERIFICATION_TIMEOUT_MS,
    }),
    caddy: options.caddy,
    reconcileBranches: options.reconcileBranches,
    events: options.previewEvents,
    intervalMs: options.routing.reconcileIntervalMs ?? DEFAULT_PREVIEW_RECONCILE_INTERVAL_MS,
  })
  const classification = new RouteOperationClassification(options.persistence)
  const abandonment = createRouteOperationAbandonmentHandlers({
    classification,
    operationEvents: options.operationEvents,
    routeEvents: options.routeEvents,
  })
  return {
    service,
    preview,
    abandonment,
  }
}
