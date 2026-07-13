import { BootstrapResourcePlanner } from './planner'
import { BootstrapProvisioningCoordinator } from './coordinator'
import { CapsuleAbandonedLifecycleOperationError, createLifecycleOperationFailureContext } from '../lifecycleLedger/errors'
import type { CapsuleBlueprintRegistry, CapsuleBootstrapCreateOutput } from '@qiln/core/server'
import type { CapsuleBranchEventPublisher } from '../branch/events'
import type { CapsuleResourceDriver } from '../resources/driver'
import type {
  CapsuleBranchResourceStore,
  CapsuleBranchStore,
  CapsuleLifecycleOperationStepStore,
  CapsuleLifecycleOperationStore,
} from '../stores'
import type { ProjectService } from '../../project'
import type { CapsuleBootstrapCreateInput } from './types'
import type { AbandonedBootstrapLifecycleOperationCandidate } from '../stores/types'

export interface CapsuleBootstrapServiceDependencies {
  branches: CapsuleBranchStore
  operations: CapsuleLifecycleOperationStore
  steps: CapsuleLifecycleOperationStepStore
  resources: CapsuleBranchResourceStore
  events: CapsuleBranchEventPublisher
  driver: CapsuleResourceDriver
  project: ProjectService
  blueprints: CapsuleBlueprintRegistry
}

/**
 * Owns root capsule initialization and its fail-closed lifecycle ledger.
 *
 * This service deliberately does not provide generic branch creation. Future branches must be forks
 * from committed snapshots through separate behavior.
 */
export class CapsuleBootstrapService {
  private readonly coordinator: BootstrapProvisioningCoordinator

  constructor(private readonly dependencies: CapsuleBootstrapServiceDependencies) {
    const bootstrapPlanner = new BootstrapResourcePlanner()
    this.coordinator = new BootstrapProvisioningCoordinator(
      {
        branches: dependencies.branches,
        operations: dependencies.operations,
        steps: dependencies.steps,
        resources: dependencies.resources,
      },
      bootstrapPlanner,
      dependencies.driver,
      dependencies.events,
      dependencies.blueprints,
      ownerId => dependencies.project.getNamespace(ownerId),
    )
  }

  public async create(input: CapsuleBootstrapCreateInput): Promise<CapsuleBootstrapCreateOutput> {
    return await this.coordinator.execute(input)
  }

  /**
   * Fails closed on bootstrap operations left nonterminal by a prior Worker process. It records
   * uncertainty for inspection and never resumes steps.
   */
  public async markAbandonedBootstrapOperationsCleanupRequired(): Promise<void> {
    const candidates = await this.dependencies.operations.listAbandonedBootstrapOperationCandidates()
    if (candidates.length === 0) {
      return
    }
    console.warn(
      `[CapsuleBootstrapService] Found ${candidates.length} abandoned capsule bootstrap operation(s). Marking cleanup_required; automatic recovery is disabled.`,
    )
    for (const candidate of candidates) {
      await this.markAbandonedBootstrapOperationCleanupRequired(candidate)
    }
  }

  private async markAbandonedBootstrapOperationCleanupRequired(candidate: AbandonedBootstrapLifecycleOperationCandidate): Promise<void> {
    const branch =
      candidate.branchId === null ? null : await this.dependencies.branches.findActiveBranchById(candidate.ownerId, candidate.branchId)
    const error = new CapsuleAbandonedLifecycleOperationError('Capsule bootstrap lifecycle operation was abandoned before completion.', {
      operationId: candidate.id,
      capsuleId: candidate.capsuleId,
      ownerId: candidate.ownerId,
      branchId: candidate.branchId,
      branchName: candidate.branchName,
      previousOperationStatus: candidate.status,
      branchExists: branch !== null,
      previousBranchStatus: branch?.status ?? null,
      policy: 'inline_fail_closed_lifecycle_ledger',
    })
    const marked = await this.dependencies.operations.markAbandonedLifecycleOperationCleanupRequired(
      candidate.ownerId,
      candidate.capsuleId,
      candidate.id,
      error,
      createLifecycleOperationFailureContext({
        operationId: candidate.id,
        capsuleId: candidate.capsuleId,
        branchId: candidate.branchId ?? undefined,
        branchName: candidate.branchName ?? undefined,
        phase: 'startup_fail_closed_sweep',
        action: 'mark_abandoned_capsule_bootstrap_cleanup_required',
      }),
    )
    if (!marked) {
      return
    }
    if (branch) {
      this.dependencies.events.publishStateChanged(candidate.ownerId, candidate.capsuleId, branch.name, 'cleanup_required')
      return
    }
    console.warn(
      `[CapsuleBootstrapService] Abandoned bootstrap lifecycle operation '${candidate.id}' has no active root branch. The capsule and operation remain available for inspection.`,
    )
  }
}
