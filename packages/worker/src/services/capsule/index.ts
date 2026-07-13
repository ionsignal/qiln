import { type CapsuleBlueprintRegistry, type CapsuleChannel, type CapsuleHostDbContract } from '@qiln/core/server'
import { IncusClient } from '../../incus/client/index'
import { ProjectService } from '../project'
import { CapsuleBootstrapService } from './bootstrap'
import { CapsuleBranchEventPublisher } from './branch/events'
import { CapsuleBranchRuntimeObserver } from './branch/providerState'
import { CapsuleBranchRuntimeService } from './branch/runtime'
import { CapsuleDestroyCoordinator, CapsuleLifecycleEventPublisher, CapsuleLifecycleService } from './lifecycle'
import { CapsuleResourceDriver } from './resources/driver'
import { CapsuleSnapshotService } from './snapshot'
import {
  CapsuleBranchResourceStore,
  CapsuleBranchStore,
  CapsuleLifecycleOperationStepStore,
  CapsuleLifecycleOperationStore,
  CapsuleSnapshotStore,
} from './stores'

export * from './bootstrap'
export * from './lifecycle'
export * from './snapshot'
export * from './branch/runtime'
export * from './branch/providerState'

/**
 * Capsule-domain composition boundary for one Worker runtime.
 *
 * The services share one durable lifecycle ledger and resource inventory while keeping operation-specific
 * policy in bootstrap, branch runtime, snapshot, and capsule lifecycle services. Infrastructure connection
 * ownership remains with `QilnWorkerRuntime`.
 */
export class CapsuleService {
  public readonly bootstrap: CapsuleBootstrapService
  public readonly branch: CapsuleBranchRuntimeService
  public readonly lifecycle: CapsuleLifecycleService
  public readonly snapshot: CapsuleSnapshotService

  constructor(
    db: CapsuleHostDbContract,
    incus: IncusClient,
    channel: CapsuleChannel,
    project: ProjectService,
    blueprints: CapsuleBlueprintRegistry,
  ) {
    const branches = new CapsuleBranchStore(db)
    const operations = new CapsuleLifecycleOperationStore(db)
    const steps = new CapsuleLifecycleOperationStepStore(db)
    const resources = new CapsuleBranchResourceStore(db)
    const snapshots = new CapsuleSnapshotStore(db)
    const branchEvents = new CapsuleBranchEventPublisher(channel)
    const lifecycleEvents = new CapsuleLifecycleEventPublisher(channel)
    const runtimeObserver = new CapsuleBranchRuntimeObserver(incus, project)
    const driver = new CapsuleResourceDriver(incus, project)
    const destroy = new CapsuleDestroyCoordinator({
      operations,
      steps,
      branches,
      resources,
      incus,
      branchEvents,
      lifecycleEvents,
    })
    this.bootstrap = new CapsuleBootstrapService({
      branches,
      operations,
      steps,
      resources,
      events: branchEvents,
      driver,
      project,
      blueprints,
    })
    this.branch = new CapsuleBranchRuntimeService({
      branches,
      events: branchEvents,
      incus,
      project,
      observer: runtimeObserver,
    })
    this.lifecycle = new CapsuleLifecycleService({
      operations,
      branches,
      destroy,
      lifecycleEvents,
      branchEvents,
    })
    this.snapshot = new CapsuleSnapshotService(snapshots)
  }

  /**
   * Performs accounting-only startup sweeps before provider reconciliation and command-handler registration.
   *
   * A nonterminal inline lifecycle operation from an earlier Worker process has uncertain provider state.
   * The Worker records cleanup-required state and never resumes, retries, compensates, or inspects provider
   * state for those lifecycle operations.
   */
  public async markAbandonedOperationsCleanupRequired(): Promise<void> {
    await this.bootstrap.markAbandonedBootstrapOperationsCleanupRequired()
    await this.lifecycle.markAbandonedDestroyOperationsCleanupRequired()
  }
}
