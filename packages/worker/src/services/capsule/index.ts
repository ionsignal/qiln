import type { CapsuleBlueprintRegistry, CapsuleChannel, CapsuleHostDbContract } from '@qiln/core/server'
import type { OperationSupervisor } from '../../coordination'
import { IncusClient } from '../../incus/client/index'
import { ProjectService } from '../project'
import { CapsuleBranchRuntimeObserver, CapsuleBranchRuntimeReconciler, CapsuleBranchRuntimeService } from './branch'
import { CapsuleBranchEventPublisher, CapsuleLifecycleEventPublisher, CapsuleOperationEventPublisher } from './events'
import { CapsuleOperationAbandonmentCoordinator, CapsuleOperationAbandonmentHandlerRegistry } from './operations/abandonment'
import {
  CapsuleArchiveAbandonmentHandler,
  CapsuleArchiveExecutor,
  CapsuleArchiveRepository,
  CapsuleArchiveSubmissionService,
} from './operations/archival/archive'
import { ProviderFreeArchivalOperationLedger } from './operations/archival/shared'
import {
  CapsuleUnarchiveAbandonmentHandler,
  CapsuleUnarchiveExecutor,
  CapsuleUnarchiveRepository,
  CapsuleUnarchiveSubmissionService,
} from './operations/archival/unarchive'
import {
  CapsuleCreateService,
  CreateCapsuleAbandonmentHandler,
  CreateCapsuleExecutor,
  CreateCapsuleOperationRepository,
} from './operations/create'
import {
  DestroyCapsuleAbandonmentHandler,
  DestroyCapsuleExecutor,
  DestroyCapsuleOperationRepository,
  DestroyCapsuleProvider,
  DestroyCapsuleSubmissionService,
} from './operations/destroy'
import { CapsuleOperationReader, CapsuleOperationStepStore } from './operations/shared'
import { CapsuleResourceDriver } from './resources/driver'
import { CapsuleSnapshotService } from './snapshot'
import { CapsuleBranchResourceStore, CapsuleBranchStore, CapsuleSnapshotStore } from './stores'

export * from './operations'
export * from './events'
export * from './snapshot'
export * from './branch'

/**
 * Capsule-domain composition boundary for one Worker runtime.
 *
 * Shared dependencies provide persistence and infrastructure mechanics only.
 * Create, archive, unarchive, and destroy retain ownership of their acceptance,
 * execution, aggregate transitions, and terminal failure policies.
 *
 * The branch service owns runtime behavior for existing branches. It does not
 * own creation of root branches or future snapshot-based branch forks.
 *
 * Startup abandonment coordination remains operation-agnostic. Each operation
 * registers an adapter that owns its repository classification and committed
 * invalidation behavior.
 */
export class CapsuleService {
  public readonly create: CapsuleCreateService
  public readonly archive: CapsuleArchiveSubmissionService
  public readonly unarchive: CapsuleUnarchiveSubmissionService
  public readonly destroy: DestroyCapsuleSubmissionService
  public readonly branch: CapsuleBranchRuntimeService
  public readonly snapshot: CapsuleSnapshotService

  private readonly abandonmentCoordinator: CapsuleOperationAbandonmentCoordinator

  constructor(
    db: CapsuleHostDbContract,
    incus: IncusClient,
    channel: CapsuleChannel,
    project: ProjectService,
    blueprints: CapsuleBlueprintRegistry,
    supervisor: OperationSupervisor,
  ) {
    const operationReader = new CapsuleOperationReader(db)
    const operationSteps = new CapsuleOperationStepStore(db)
    const branches = new CapsuleBranchStore(db)
    const resources = new CapsuleBranchResourceStore(db)
    const snapshots = new CapsuleSnapshotStore(db)

    const operationEvents = new CapsuleOperationEventPublisher(channel)
    const lifecycleEvents = new CapsuleLifecycleEventPublisher(channel)
    const branchEvents = new CapsuleBranchEventPublisher(channel)

    const runtimeObserver = new CapsuleBranchRuntimeObserver(incus, project)
    const runtimeReconciler = new CapsuleBranchRuntimeReconciler({
      branches,
      events: branchEvents,
      observer: runtimeObserver,
    })

    const resourceDriver = new CapsuleResourceDriver(incus, project)

    const createRepository = new CreateCapsuleOperationRepository(db, operationReader)
    const createExecutor = new CreateCapsuleExecutor({
      repository: createRepository,
      steps: operationSteps,
      resources,
      driver: resourceDriver,
      project,
      operationEvents,
      lifecycleEvents,
      branchEvents,
    })

    this.create = new CapsuleCreateService(
      createRepository,
      createExecutor,
      supervisor,
      blueprints,
      operationEvents,
      lifecycleEvents,
      branchEvents,
    )

    const archivalOperationLedger = new ProviderFreeArchivalOperationLedger(db, operationReader)

    const archiveRepository = new CapsuleArchiveRepository(db, archivalOperationLedger)
    const archiveExecutor = new CapsuleArchiveExecutor({
      repository: archiveRepository,
      operationEvents,
      lifecycleEvents,
    })

    this.archive = new CapsuleArchiveSubmissionService(archiveRepository, archiveExecutor, supervisor, operationEvents, lifecycleEvents)

    const unarchiveRepository = new CapsuleUnarchiveRepository(db, archivalOperationLedger)
    const unarchiveExecutor = new CapsuleUnarchiveExecutor({
      repository: unarchiveRepository,
      operationEvents,
      lifecycleEvents,
    })

    this.unarchive = new CapsuleUnarchiveSubmissionService(unarchiveRepository, unarchiveExecutor, supervisor, operationEvents, lifecycleEvents)

    const destroyRepository = new DestroyCapsuleOperationRepository(db, operationReader)
    const destroyProvider = new DestroyCapsuleProvider({
      incus,
      resources,
    })
    const destroyExecutor = new DestroyCapsuleExecutor({
      repository: destroyRepository,
      steps: operationSteps,
      resources,
      provider: destroyProvider,
      operationEvents,
      lifecycleEvents,
      branchEvents,
    })

    this.destroy = new DestroyCapsuleSubmissionService(
      destroyRepository,
      destroyExecutor,
      supervisor,
      operationEvents,
      lifecycleEvents,
      branchEvents,
    )

    this.branch = new CapsuleBranchRuntimeService({
      branches,
      events: branchEvents,
      observer: runtimeObserver,
      reconciler: runtimeReconciler,
      incus,
      project,
    })

    this.snapshot = new CapsuleSnapshotService(snapshots)

    const abandonmentHandlers = new CapsuleOperationAbandonmentHandlerRegistry([
      new CreateCapsuleAbandonmentHandler({
        repository: createRepository,
        operationEvents,
        lifecycleEvents,
        branchEvents,
      }),
      new CapsuleArchiveAbandonmentHandler({
        repository: archiveRepository,
        operationEvents,
        lifecycleEvents,
      }),
      new CapsuleUnarchiveAbandonmentHandler({
        repository: unarchiveRepository,
        operationEvents,
        lifecycleEvents,
      }),
      new DestroyCapsuleAbandonmentHandler({
        repository: destroyRepository,
        operationEvents,
        lifecycleEvents,
        branchEvents,
      }),
    ])

    this.abandonmentCoordinator = new CapsuleOperationAbandonmentCoordinator({
      reader: operationReader,
      steps: operationSteps,
      handlers: abandonmentHandlers,
    })
  }

  /**
   * Classifies durable nonterminal operations left by an earlier Worker before
   * runtime reconciliation or command intake becomes available.
   *
   * Operation-local adapters own classification transactions, committed
   * identity validation, and invalidation publication. The shared coordinator
   * performs no provider inspection, executor replay, compensation, or generic
   * aggregate restoration.
   */
  public async classifyAbandonedOperationsAtStartup(): Promise<void> {
    await this.abandonmentCoordinator.classifyAtStartup()
  }
}
