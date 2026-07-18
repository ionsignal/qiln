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
import { composeCreateCapability } from './create'
import { composeDestroyCapability } from './destroy'
import { composeSnapshotCapability } from './snapshot'
import { composeUnarchiveCapability } from './unarchive'
import type { ProjectService } from '../../project'
import type { IncusClient } from '../../../incus/client/index'
import type { OperationSupervisor } from '../../../coordination/supervisor'
import type { CapsuleBlueprintRegistry, CapsuleChannel, CapsuleHostDbContract } from '@qiln/core/server'

export interface ComposeCapsuleServiceOptions {
  db: CapsuleHostDbContract
  incus: IncusClient
  channel: CapsuleChannel
  project: ProjectService
  blueprints: CapsuleBlueprintRegistry
  supervisor: OperationSupervisor
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
export function composeCapsuleService(options: ComposeCapsuleServiceOptions): CapsuleService {
  const operationReader = new CapsuleOperationReader(options.db)
  const operationSteps = new CapsuleOperationStepStore(options.db)
  const resources = new CapsuleBranchResourceStore(options.db)

  const operationEvents = new CapsuleOperationEventPublisher(options.channel)
  const lifecycleEvents = new CapsuleLifecycleEventPublisher(options.channel)
  const branchEvents = new CapsuleBranchEventPublisher(options.channel)

  const create = composeCreateCapability({
    db: options.db,
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

  /**
   * Archive and unarchive intentionally share only their provider-free archival
   * ledger mechanics. Their lifecycle and timestamp policies remain separate.
   */
  const archivalOperationLedger = new ProviderFreeArchivalOperationLedger(options.db, operationReader)
  const archive = composeArchiveCapability({
    db: options.db,
    supervisor: options.supervisor,
    operationLedger: archivalOperationLedger,
    operationEvents,
    lifecycleEvents,
  })
  const unarchive = composeUnarchiveCapability({
    db: options.db,
    supervisor: options.supervisor,
    operationLedger: archivalOperationLedger,
    operationEvents,
    lifecycleEvents,
  })
  const destroy = composeDestroyCapability({
    db: options.db,
    incus: options.incus,
    supervisor: options.supervisor,
    operationReader,
    operationSteps,
    resources,
    operationEvents,
    lifecycleEvents,
    branchEvents,
  })
  const branch = composeBranchCapability({
    db: options.db,
    incus: options.incus,
    project: options.project,
    branchEvents,
  })
  const snapshot = composeSnapshotCapability({
    db: options.db,
  })
  /**
   * Registration order remains create, archive, unarchive, destroy. The
   * registry still verifies complete coverage before startup classification.
   */
  const abandonmentHandlers = new CapsuleOperationAbandonmentHandlerRegistry([
    create.abandonment,
    archive.abandonment,
    unarchive.abandonment,
    destroy.abandonment,
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
    branch,
    snapshot,
    abandonmentCoordinator,
  })
}
