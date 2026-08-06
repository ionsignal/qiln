import { CapsuleService } from '../facade'
import { CapsuleRuntimeReconciliationCoordinator } from '../reconciliation'
import { CapsuleBranchEventPublisher } from '../events/branch'
import { CapsuleLifecycleEventPublisher } from '../events/lifecycle'
import { CapsuleOperationEventPublisher } from '../events/operation'
import { CapsulePreviewEventPublisher } from '../events/preview'
import { CapsuleRouteEventPublisher } from '../events/route'
import { CapsuleOperationAbandonmentCoordinator } from '../operations/abandonment/coordinator'
import { CapsuleOperationAbandonmentHandlerRegistry } from '../operations/abandonment/handler'
import { ProviderFreeArchivalOperationLedger } from '../operations/archival/shared/operationLedger'
import { CapsuleOperationReader } from '../operations/shared/operationReader'
import { CapsuleOperationStepStore } from '../operations/shared/operationStepStore'
import { CapsuleBranchResourceStore } from '../resource/store'
import { PreviewGate } from '../routing/preview/gate'
import { composeArchiveCapability } from './archive'
import { composeBranchCapability } from './branch'
import { composeCaptureCapability } from './capture'
import { composeCreateCapability } from './create'
import { composeDestroyCapability } from './destroy'
import { composeForkCapability } from './fork'
import { composeRoutingCapability } from './routing'
import { composeSnapshotCapability } from './snapshot'
import { composeUnarchiveCapability } from './unarchive'
import type { CaddyClient } from '../../../caddy'
import type { WorkerRoutingConfig } from '../../../types'
import type { ProjectService } from '../../project'
import type { IncusClient } from '../../../incus/client/index'
import type { OperationSupervisor } from '../../../coordination/supervisor'
import type { CapsuleBlueprintRegistry, CapsuleChannel, CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

const DEFAULT_RUNTIME_RECONCILE_INTERVAL_MS = 15_000

export interface ComposeCapsuleServiceOptions<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  persistence: CapsulePersistence<TDatabase, TTables>
  incus: IncusClient
  channel: CapsuleChannel
  project: ProjectService
  caddy: CaddyClient
  routing: WorkerRoutingConfig
  blueprints: CapsuleBlueprintRegistry
  supervisor: OperationSupervisor
  experimentalSnapshotsEnabled: boolean
}

/**
 * Composes the complete capsule-domain dependency graph for one Worker runtime.
 *
 * Shared objects here provide persistence or invalidation mechanics only.
 * Operation-specific acceptance, execution, provider fencing, compensation,
 * terminal classification, and abandonment policy remain inside their vertical
 * slices.
 *
 * Composition is synchronous and performs no database access, provider
 * mutation, command registration, reconciliation, event publication, or
 * operation scheduling.
 */
export function composeCapsuleService<TDatabase extends PostgresJsDatabase, TTables extends CapsuleTables>(
  options: ComposeCapsuleServiceOptions<TDatabase, TTables>,
): CapsuleService {
  const operationReader = new CapsuleOperationReader(options.persistence)
  const operationSteps = new CapsuleOperationStepStore(options.persistence)
  const resources = new CapsuleBranchResourceStore(options.persistence)
  const previewGate = new PreviewGate(options.persistence)
  const operationEvents = new CapsuleOperationEventPublisher(options.channel)
  const lifecycleEvents = new CapsuleLifecycleEventPublisher(options.channel)
  const branchEvents = new CapsuleBranchEventPublisher(options.channel)
  const previewEvents = new CapsulePreviewEventPublisher(options.channel)
  const routeEvents = new CapsuleRouteEventPublisher(options.channel)
  const archivalOperationLedger = new ProviderFreeArchivalOperationLedger(options.persistence, operationReader)
  const archive = composeArchiveCapability({
    persistence: options.persistence,
    supervisor: options.supervisor,
    operationLedger: archivalOperationLedger,
    operationEvents,
    lifecycleEvents,
    previewGate,
  })
  const unarchive = composeUnarchiveCapability({
    persistence: options.persistence,
    supervisor: options.supervisor,
    operationLedger: archivalOperationLedger,
    operationEvents,
    lifecycleEvents,
  })
  const create = composeCreateCapability({
    persistence: options.persistence,
    incus: options.incus,
    project: options.project,
    blueprints: options.blueprints,
    supervisor: options.supervisor,
    operationReader,
    operationSteps,
    resources,
    operationEvents,
    lifecycleEvents,
    branchEvents,
  })
  const fork = composeForkCapability({
    persistence: options.persistence,
    incus: options.incus,
    project: options.project,
    supervisor: options.supervisor,
    operationReader,
    operationSteps,
    resources,
    operationEvents,
    lifecycleEvents,
    branchEvents,
    enabled: options.experimentalSnapshotsEnabled,
  })
  const destroy = composeDestroyCapability({
    persistence: options.persistence,
    incus: options.incus,
    supervisor: options.supervisor,
    operationReader,
    operationSteps,
    resources,
    operationEvents,
    lifecycleEvents,
    branchEvents,
    previewGate,
  })
  const capture = composeCaptureCapability({
    persistence: options.persistence,
    incus: options.incus,
    supervisor: options.supervisor,
    operationReader,
    operationSteps,
    operationEvents,
    lifecycleEvents,
    branchEvents,
    previewGate,
    enabled: options.experimentalSnapshotsEnabled,
  })
  const snapshot = composeSnapshotCapability({
    persistence: options.persistence,
    incus: options.incus,
  })
  const route = composeRoutingCapability({
    persistence: options.persistence,
    caddy: options.caddy,
    routing: options.routing,
    operationEvents,
    previewEvents,
    routeEvents,
  })
  const branch = composeBranchCapability({
    persistence: options.persistence,
    incus: options.incus,
    project: options.project,
    branchEvents,
    previews: route.preview,
    previewGate,
  })
  const reconciliation = new CapsuleRuntimeReconciliationCoordinator({
    branch,
    preview: route.reconciliation,
    intervalMs: options.routing.reconcileIntervalMs ?? DEFAULT_RUNTIME_RECONCILE_INTERVAL_MS,
  })
  const abandonmentHandlers = new CapsuleOperationAbandonmentHandlerRegistry([
    create.abandonment,
    fork.abandonment,
    archive.abandonment,
    unarchive.abandonment,
    destroy.abandonment,
    capture.abandonment,
    ...route.abandonment,
  ])
  const abandonmentCoordinator = new CapsuleOperationAbandonmentCoordinator({
    reader: operationReader,
    steps: operationSteps,
    handlers: abandonmentHandlers,
  })

  return new CapsuleService({
    create: create.submission,
    fork: fork.submission,
    archive: archive.submission,
    unarchive: unarchive.submission,
    destroy: destroy.submission,
    capture: capture.submission,
    branch,
    snapshot,
    preview: route.preview,
    route: route.service,
    reconciliation,
    abandonment: abandonmentCoordinator,
  })
}
