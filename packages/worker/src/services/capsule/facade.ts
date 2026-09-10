import type { CapsuleBranchRuntimeService } from './branch/service'
import type { DiffService } from './diff/service'
import type { CapsuleRuntimeReconciliationCoordinator } from './reconciliation'
import type { CapsuleOperationAbandonmentCoordinator } from './operations/abandonment/coordinator'
import type { CapsuleArchiveSubmissionService } from './operations/archival/archive/submission'
import type { CapsuleUnarchiveSubmissionService } from './operations/archival/unarchive/submission'
import type { BranchSubmission } from './operations/branch/submission'
import type { CreateCapsuleSubmissionService } from './operations/create/submission'
import type { DestroyCapsuleSubmissionService } from './operations/destroy/submission'
import type { ForkSubmission } from './operations/fork/submission'
import type { SnapshotSubmission } from './operations/snapshot/submission'
import type { CommittedRouteService } from './routing/service'
import type { CapsuleSnapshotService } from './snapshot/service'
import type { PreviewService } from './routing/preview/service'

/**
 * Fully composed capsule capabilities exposed by one Worker runtime.
 *
 * Construction belongs to `composition/`. The facade receives ready-to-use
 * capabilities and contains no infrastructure wiring, persistence access,
 * provider access, handler registration, or lifecycle policy.
 */
export interface CapsuleServiceCapabilities {
  create: CreateCapsuleSubmissionService
  fork: ForkSubmission
  archive: CapsuleArchiveSubmissionService
  unarchive: CapsuleUnarchiveSubmissionService
  destroy: DestroyCapsuleSubmissionService
  createSnapshot: SnapshotSubmission
  start: BranchSubmission<'branch_start'>
  stop: BranchSubmission<'branch_stop'>
  branch: CapsuleBranchRuntimeService
  snapshot: CapsuleSnapshotService
  diff: DiffService
  route: CommittedRouteService
  preview: PreviewService
  reconciliation: CapsuleRuntimeReconciliationCoordinator
  abandonment: CapsuleOperationAbandonmentCoordinator
}

/**
 * Small public facade for the Worker capsule domain.
 *
 * Each mutation remains implemented by its operation-specific vertical slice.
 * This facade only exposes those capabilities and delegates startup abandonment
 * classification to the shared coordinator.
 */
export class CapsuleService {
  public readonly create: CreateCapsuleSubmissionService
  public readonly fork: ForkSubmission
  public readonly archive: CapsuleArchiveSubmissionService
  public readonly unarchive: CapsuleUnarchiveSubmissionService
  public readonly destroy: DestroyCapsuleSubmissionService
  public readonly createSnapshot: SnapshotSubmission
  public readonly start: BranchSubmission<'branch_start'>
  public readonly stop: BranchSubmission<'branch_stop'>
  public readonly branch: CapsuleBranchRuntimeService
  public readonly snapshot: CapsuleSnapshotService
  public readonly diff: DiffService
  public readonly route: CommittedRouteService
  public readonly preview: PreviewService
  public readonly reconciliation: CapsuleRuntimeReconciliationCoordinator

  private readonly abandonment: CapsuleOperationAbandonmentCoordinator

  constructor(capabilities: CapsuleServiceCapabilities) {
    this.create = capabilities.create
    this.fork = capabilities.fork
    this.archive = capabilities.archive
    this.unarchive = capabilities.unarchive
    this.destroy = capabilities.destroy
    this.createSnapshot = capabilities.createSnapshot
    this.start = capabilities.start
    this.stop = capabilities.stop
    this.branch = capabilities.branch
    this.snapshot = capabilities.snapshot
    this.diff = capabilities.diff
    this.route = capabilities.route
    this.preview = capabilities.preview
    this.reconciliation = capabilities.reconciliation
    this.abandonment = capabilities.abandonment
  }

  /**
   * Classifies durable nonterminal operations left by an earlier Worker before
   * runtime reconciliation or command intake becomes available.
   *
   * Operation-local adapters continue to own classification transactions,
   * committed identity validation, and invalidation publication. The facade
   * performs no provider inspection, executor replay, compensation, or generic
   * aggregate restoration.
   */
  public async classifyAbandonedOperationsAtStartup(): Promise<void> {
    await this.abandonment.classifyAtStartup()
  }
}
