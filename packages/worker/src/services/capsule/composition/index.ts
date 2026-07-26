import { CapsuleService } from '../facade'
import { CapsuleBranchEventPublisher } from '../events/branch'
import { CapsuleLifecycleEventPublisher } from '../events/lifecycle'
import { CapsuleOperationEventPublisher } from '../events/operation'
import { CapsuleOperationAbandonmentCoordinator } from '../operations/abandonment/coordinator'
import { CapsuleOperationAbandonmentHandlerRegistry } from '../operations/abandonment/handler'
import { ProviderFreeArchivalOperationLedger } from '../operations/archival/shared/operationLedger'
import { CapsuleOperationReader } from '../operations/shared/operationReader'
import { CapsuleOperationStepStore } from '../operations/shared/operationStepStore'
import { CapsuleBranchResourceStore } from '../resource/store'
import { composeArchiveCapability } from './archive'
import { composeBranchCapability } from './branch'
import { composeCaptureCapability } from './capture'
import { composeCreateCapability } from './create'
import { composeDestroyCapability } from './destroy'
import { composeSnapshotCapability } from './snapshot'
import { composeUnarchiveCapability } from './unarchive'
import type { ProjectService } from '../../project'
import type { IncusClient } from '../../../incus/client/index'
import type { OperationSupervisor } from '../../../coordination/supervisor'
import type { CapsuleBlueprintRegistry, CapsuleChannel, QilnPersistence, QilnTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

export interface ComposeCapsuleServiceOptions<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends QilnTables = QilnTables,
> {
  persistence: QilnPersistence<TDatabase, TTables>
  incus: IncusClient
  channel: CapsuleChannel
  project: ProjectService
  blueprints: CapsuleBlueprintRegistry
  supervisor: OperationSupervisor
  experimentalCaptureEnabled: boolean
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
export function composeCapsuleService<TDatabase extends PostgresJsDatabase, TTables extends QilnTables>(
  options: ComposeCapsuleServiceOptions<TDatabase, TTables>,
): CapsuleService {
  // Helpers
  const operationReader = new CapsuleOperationReader(options.persistence)
  const operationSteps = new CapsuleOperationStepStore(options.persistence)
  const resources = new CapsuleBranchResourceStore(options.persistence)
  // Events
  const operationEvents = new CapsuleOperationEventPublisher(options.channel)
  const lifecycleEvents = new CapsuleLifecycleEventPublisher(options.channel)
  const branchEvents = new CapsuleBranchEventPublisher(options.channel)
  // Archival Operations
  const archivalOperationLedger = new ProviderFreeArchivalOperationLedger(options.persistence, operationReader)
  const archive = composeArchiveCapability({
    persistence: options.persistence,
    supervisor: options.supervisor,
    operationLedger: archivalOperationLedger,
    operationEvents,
    lifecycleEvents,
  })
  const unarchive = composeUnarchiveCapability({
    persistence: options.persistence,
    supervisor: options.supervisor,
    operationLedger: archivalOperationLedger,
    operationEvents,
    lifecycleEvents,
  })
  // Create/Destroy Operation
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
  })
  // Snapshot Capture Operation
  const capture = composeCaptureCapability({
    persistence: options.persistence,
    incus: options.incus,
    supervisor: options.supervisor,
    operationReader,
    operationSteps,
    operationEvents,
    lifecycleEvents,
    branchEvents,
    enabled: options.experimentalCaptureEnabled,
  })
  // Branch
  const branch = composeBranchCapability({
    persistence: options.persistence,
    incus: options.incus,
    project: options.project,
    branchEvents,
  })
  // Snapshot
  const snapshot = composeSnapshotCapability({
    persistence: options.persistence,
  })
  // Abandonment
  const abandonmentHandlers = new CapsuleOperationAbandonmentHandlerRegistry([
    create.abandonment,
    archive.abandonment,
    unarchive.abandonment,
    destroy.abandonment,
    capture.abandonment,
  ])
  const abandonmentCoordinator = new CapsuleOperationAbandonmentCoordinator({
    reader: operationReader,
    steps: operationSteps,
    handlers: abandonmentHandlers,
  })
  return new CapsuleService({
    create: create.submission,
    archive: archive.submission,
    unarchive: unarchive.submission,
    destroy: destroy.submission,
    capture: capture.submission,
    branch,
    snapshot,
    abandonmentCoordinator,
  })
}
